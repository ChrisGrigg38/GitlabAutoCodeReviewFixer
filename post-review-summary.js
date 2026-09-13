#!/usr/bin/env node
/**
 * post-review-summary.js  (Script B)
 *
 * Reads the review-summary.md file produced by the coding agent (see
 * extract-review-comments.js for the exact format it's expected to follow)
 * and posts a reply into each corresponding GitLab discussion thread.
 *
 * Safety checks before posting to a thread:
 *   1. If we've already posted an automated reply to this discussion before
 *      (detected via a hidden marker embedded in our own replies), skip it —
 *      never double-post.
 *   2. If a human has replied to the thread since the summary was written
 *      (i.e. there's a reply that isn't our own automated one), skip it and
 *      leave a note in the run log — per your instructions, once someone's
 *      replied, it's usually best left alone rather than posting over them.
 *
 * Optionally resolves discussions that were marked "Updated" (--resolve-fixed).
 *
 * Requirements:
 *   - Node.js 18+ (uses global fetch)
 *   - GITLAB_TOKEN env var with `api` scope (needs WRITE access this time)
 *
 * Usage:
 *   GITLAB_TOKEN=glpat-xxxx node post-review-summary.js <MR_URL> <summary.md> [options]
 *
 * Options:
 *   --resolve-fixed   Mark discussions resolved when Status: Updated
 *   --dry-run         Print what would be posted without calling the API
 */

const fs = require('fs');
const path = require('path');
const { parseMrUrl, GitLabClient, AUTO_REPLY_MARKER } = require('./gitlab-lib');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resolve-fixed') args.resolveFixed = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--token') args.token = argv[++i];
    else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Summary file parsing
// ---------------------------------------------------------------------------

/**
 * Parses the exact format specified in extract-review-comments.js:
 *
 * ## Comment <discussion_id>
 * Status: Updated
 * Summary: ...
 *
 * ## Comment <discussion_id>
 * Status: Not Updated
 * Reason: ...
 * Reply:
 * ```
 * ...multi-line reply...
 * ```
 */
function parseSummaryFile(text) {
  const entries = [];
  // Split on section headers, keeping the header with its body.
  const sectionRe = /^##\s*Comment\s+(\S+)\s*$/gm;
  const matches = [...text.matchAll(sectionRe)];

  for (let i = 0; i < matches.length; i++) {
    const discussionId = matches[i][1].replace(/^`|`$/g, ''); // tolerate backticks
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end);

    const statusMatch = body.match(/^Status:\s*(Updated|Not Updated)\s*$/im);
    if (!statusMatch) {
      entries.push({ discussionId, error: 'No recognizable "Status:" line found in this section.' });
      continue;
    }
    const status = statusMatch[1].trim();

    if (/^Updated$/i.test(status)) {
      const summaryMatch = body.match(/^Summary:\s*(.+)$/im);
      entries.push({
        discussionId,
        status: 'Updated',
        summary: summaryMatch ? summaryMatch[1].trim() : '(no summary provided)',
      });
    } else {
      const reasonMatch = body.match(/^Reason:\s*(.+)$/im);
      const replyMatch = body.match(/Reply:\s*```[^\n]*\n([\s\S]*?)\n```/m);
      if (!replyMatch) {
        entries.push({
          discussionId,
          error: 'Status is "Not Updated" but no fenced Reply: block was found.',
        });
        continue;
      }
      entries.push({
        discussionId,
        status: 'Not Updated',
        reason: reasonMatch ? reasonMatch[1].trim() : '(no reason provided)',
        reply: replyMatch[1].trim(),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Posting logic
// ---------------------------------------------------------------------------

function hasAutoReply(discussion) {
  return discussion.notes.some((n) => n.body.includes(AUTO_REPLY_MARKER));
}

function hasHumanReplySinceOurLast(discussion) {
  // "Human reply" = any non-system note that is not one of our own tagged
  // replies, appearing after the first note (i.e. someone other than the
  // original commenter responded, and it wasn't us).
  const nonSystem = discussion.notes.filter((n) => !n.system);
  const rest = nonSystem.slice(1);
  return rest.some((n) => !n.body.includes(AUTO_REPLY_MARKER));
}

async function processEntry(client, project, mrIid, entry, opts, log) {
  if (entry.error) {
    log.push({ discussionId: entry.discussionId, action: 'skipped', reason: `Parse error: ${entry.error}` });
    return;
  }

  let discussion;
  try {
    discussion = await client.getDiscussion(project.id, mrIid, entry.discussionId);
  } catch (err) {
    log.push({
      discussionId: entry.discussionId,
      action: 'skipped',
      reason: `Could not fetch discussion from GitLab: ${err.message}`,
    });
    return;
  }

  if (hasAutoReply(discussion)) {
    log.push({ discussionId: entry.discussionId, action: 'skipped', reason: 'Already posted an automated reply here previously.' });
    return;
  }

  if (hasHumanReplySinceOurLast(discussion)) {
    log.push({
      discussionId: entry.discussionId,
      action: 'skipped',
      reason: 'Someone has already replied to this thread since the summary was generated — leaving it alone.',
    });
    return;
  }

  const body =
    entry.status === 'Updated'
      ? `Updated: ${entry.summary}\n\n${AUTO_REPLY_MARKER}`
      : `${entry.reply}\n\n${AUTO_REPLY_MARKER}`;

  if (opts.dryRun) {
    log.push({
      discussionId: entry.discussionId,
      action: 'would-post',
      reason: `[dry-run] Would post reply:\n${body}`,
    });
    return;
  }

  await client.addDiscussionNote(project.id, mrIid, entry.discussionId, body);
  let resolvedNote = '';
  if (opts.resolveFixed && entry.status === 'Updated') {
    try {
      await client.resolveDiscussion(project.id, mrIid, entry.discussionId, true);
      resolvedNote = ' (and marked resolved)';
    } catch (err) {
      resolvedNote = ` (posted, but failed to resolve: ${err.message})`;
    }
  }

  log.push({ discussionId: entry.discussionId, action: 'posted', reason: `Posted reply${resolvedNote}.` });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [mrUrl, summaryPath] = args._;

  if (!mrUrl || !summaryPath) {
    console.error(
      'Usage: node post-review-summary.js <MR_URL> <path-to-review-summary.md> [--resolve-fixed] [--dry-run]'
    );
    process.exit(1);
  }

  const token = args.token || process.env.GITLAB_TOKEN;
  if (!token) {
    console.error('Missing GitLab token. Set GITLAB_TOKEN env var or pass --token <token>.');
    process.exit(1);
  }

  if (!fs.existsSync(summaryPath)) {
    console.error(`Summary file not found: ${summaryPath}`);
    process.exit(1);
  }

  const { host, projectPath, mrIid } = parseMrUrl(mrUrl);
  const client = new GitLabClient(host, token);

  console.log(`Resolving project "${projectPath}" on ${host}...`);
  const project = await client.getProject(projectPath);

  const summaryText = fs.readFileSync(summaryPath, 'utf8');
  const entries = parseSummaryFile(summaryText);

  if (entries.length === 0) {
    console.error('No "## Comment <discussion_id>" sections found in the summary file. Nothing to do.');
    process.exit(1);
  }

  console.log(`Parsed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from summary file.`);
  if (args.dryRun) console.log('(dry run — no changes will be made to GitLab)\n');

  const log = [];
  for (const entry of entries) {
    await processEntry(client, project, mrIid, entry, args, log);
  }

  // Console summary
  console.log('\nResults:');
  for (const item of log) {
    console.log(`  [${item.action}] ${item.discussionId} — ${item.reason.split('\n')[0]}`);
  }

  // Write a durable log file next to the summary file
  const logPath = path.join(path.dirname(summaryPath), 'post-review-log.md');
  const logMd =
    `# Post Review Summary Log — !${mrIid}\n\nRun at: ${new Date().toISOString()}\n\n` +
    log
      .map((item) => `## ${item.discussionId}\n- action: ${item.action}\n- detail: ${item.reason}\n`)
      .join('\n');
  fs.writeFileSync(logPath, logMd, 'utf8');
  console.log(`\nLog written to ${logPath}`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
