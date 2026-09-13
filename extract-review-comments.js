#!/usr/bin/env node
/**
 * extract-review-comments.js  (Script A)
 *
 * Given a GitLab merge request URL, pulls unresolved, unanswered code-review
 * comments via the GitLab API, attaches a window of surrounding source code
 * to each one (line numbers drift, so the agent needs real context, not just
 * a line number), and writes a single Markdown file you hand to a coding
 * agent (e.g. paste into Cursor).
 *
 * A comment is skipped (left for you to handle manually) if:
 *   - it's already marked resolved, or
 *   - it already has a reply (someone — reviewer or author — responded),
 *     since that usually means it's already been worked or discussed.
 * Both are configurable via --include-resolved / --include-replied.
 * Skipped comments are still listed, with their reason, in
 * skipped-comments.md so you know what wasn't handed to the agent and why.
 *
 * This script does not itself decide whether a comment is valid — that
 * judgment is left to the coding agent. What it does is (a) filter out
 * comments that plausibly don't need attention, (b) give the agent precise
 * instructions on HOW to decide fix vs. no-fix, and (c) specify an exact,
 * machine-parseable format for the summary report the agent must produce —
 * that summary is what script B (post-review-summary.js) later reads to
 * post replies back to GitLab.
 *
 * Requirements:
 *   - Node.js 18+ (uses global fetch)
 *   - GITLAB_TOKEN env var with `api` (read) scope
 *
 * Usage:
 *   GITLAB_TOKEN=glpat-xxxx node extract-review-comments.js <MR_URL> [options]
 *
 * Options:
 *   --out <dir>          Output directory (default: ./review-output)
 *   --context <n>        Lines of code context above/below each comment (default: 15)
 *   --include-resolved   Include discussions already marked resolved
 *   --include-replied    Include discussions that already have a reply
 */

const fs = require('fs');
const path = require('path');
const { parseMrUrl, GitLabClient } = require('./gitlab-lib');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--context') args.context = parseInt(argv[++i], 10);
    else if (a === '--include-resolved') args.includeResolved = true;
    else if (a === '--include-replied') args.includeReplied = true;
    else if (a === '--token') args.token = argv[++i];
    else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Discussion classification
// ---------------------------------------------------------------------------

function isCodeDiscussion(discussion) {
  const first = discussion.notes && discussion.notes[0];
  return !!(first && first.type === 'DiffNote' && first.position);
}

// Returns { include: bool, reason: string|null }
function classifyDiscussion(discussion, opts) {
  const first = discussion.notes[0];
  const nonSystemNotes = discussion.notes.filter((n) => !n.system);

  const isResolved = !!(first.resolvable && first.resolved);
  if (isResolved && !opts.includeResolved) {
    return { include: false, reason: 'Already marked resolved.' };
  }

  if (nonSystemNotes.length > 1 && !opts.includeReplied) {
    const lastAuthor = nonSystemNotes[nonSystemNotes.length - 1].author.name;
    return {
      include: false,
      reason: `Thread already has a reply (last reply by ${lastAuthor}) — assumed already handled or being discussed.`,
    };
  }

  return { include: true, reason: null };
}

// ---------------------------------------------------------------------------
// Code context
// ---------------------------------------------------------------------------

async function getContextWindow(client, projectId, position, contextLines) {
  const useNew = position.new_line != null;
  const filePath = useNew ? position.new_path : position.old_path;
  const ref = useNew ? position.head_sha : position.base_sha;
  const targetLine = useNew ? position.new_line : position.old_line;

  if (!filePath || !ref || !targetLine) {
    return { filePath, side: useNew ? 'new' : 'old', targetLine, snippet: null };
  }

  const content = await client.getRawFile(projectId, filePath, ref);
  if (content == null) {
    return { filePath, side: useNew ? 'new' : 'old', targetLine, snippet: null };
  }

  const lines = content.split('\n');
  const startLine = Math.max(1, targetLine - contextLines);
  const endLine = Math.min(lines.length, targetLine + contextLines);
  const windowLines = lines.slice(startLine - 1, endLine);

  return {
    filePath,
    side: useNew ? 'new' : 'old',
    targetLine,
    startLine,
    endLine,
    snippet: windowLines
      .map((l, idx) => {
        const lineNo = startLine + idx;
        const marker = lineNo === targetLine ? '>>' : '  ';
        return `${marker} ${String(lineNo).padStart(5)} | ${l}`;
      })
      .join('\n'),
  };
}

function formatThread(discussion) {
  const notes = discussion.notes.filter((n) => !n.system);
  return notes
    .map((n) => {
      const when = new Date(n.created_at).toISOString().slice(0, 16).replace('T', ' ');
      return `**${n.author.name}** (${when}):\n${n.body}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mrUrl = args._[0];
  if (!mrUrl) {
    console.error(
      'Usage: node extract-review-comments.js <MR_URL> [--out dir] [--context n] [--include-resolved] [--include-replied]'
    );
    process.exit(1);
  }

  const token = args.token || process.env.GITLAB_TOKEN;
  if (!token) {
    console.error('Missing GitLab token. Set GITLAB_TOKEN env var or pass --token <token>.');
    process.exit(1);
  }

  const contextLines = Number.isInteger(args.context) ? args.context : 15;
  const outDir = args.out || './review-output';
  fs.mkdirSync(outDir, { recursive: true });

  const { host, projectPath, mrIid } = parseMrUrl(mrUrl);
  const client = new GitLabClient(host, token);

  console.log(`Resolving project "${projectPath}" on ${host}...`);
  const project = await client.getProject(projectPath);

  console.log(`Fetching MR !${mrIid}...`);
  const mr = await client.getMergeRequest(project.id, mrIid);

  console.log('Fetching discussions...');
  const discussions = (await client.getDiscussions(project.id, mrIid)).filter(isCodeDiscussion);

  const included = [];
  const skipped = [];
  for (const discussion of discussions) {
    const { include, reason } = classifyDiscussion(discussion, args);
    if (include) included.push(discussion);
    else skipped.push({ discussion, reason });
  }

  console.log(
    `Found ${discussions.length} code-review discussion(s): ${included.length} to send to the agent, ${skipped.length} skipped.`
  );

  console.log('Fetching surrounding code context for each included comment...');
  const items = [];
  for (const discussion of included) {
    const first = discussion.notes[0];
    const context = await getContextWindow(client, project.id, first.position, contextLines);
    items.push({ discussion, position: first.position, context });
  }

  const agentFilePath = path.join(outDir, 'review-comments-for-agent.md');
  const skippedFilePath = path.join(outDir, 'skipped-comments.md');
  const summaryFilePath = path.join(outDir, 'review-summary.md'); // where the AGENT writes its output

  fs.writeFileSync(
    agentFilePath,
    buildAgentMarkdown({ mr, mrUrl, project, items, contextLines, summaryFilePath }),
    'utf8'
  );
  fs.writeFileSync(skippedFilePath, buildSkippedMarkdown({ mr, skipped }), 'utf8');

  console.log(`\nDone.`);
  console.log(`  -> ${agentFilePath}   (paste this into Cursor / your coding agent)`);
  console.log(`  -> ${skippedFilePath}      (comments left out and why — review manually if needed)`);
  console.log(`\nAfter the agent finishes, it should have written:`);
  console.log(`  -> ${summaryFilePath}      (read this with post-review-summary.js)`);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function buildAgentMarkdown({ mr, mrUrl, project, items, contextLines, summaryFilePath }) {
  const header = `# Code Review Comments — ${project.path_with_namespace} !${mr.iid}

Source MR: ${mrUrl}
Title: ${mr.title}
Branch: \`${mr.source_branch}\` -> \`${mr.target_branch}\`

## Instructions for the coding agent

Below are unresolved, unanswered code-review comments, each with ${contextLines}
lines of surrounding source code. **Line numbers from GitLab may not point at
exactly the right spot** — the branch may have moved on since the comment was
posted. Use the code context (not just the line number marked with \`>>\`) to
find the real location; search the file if the described issue isn't exactly
where marked.

### Decision rule for every comment

Default to **making the fix**. Only leave a comment unaddressed if applying it
would actually break existing functionality or is clearly out of scope for a
targeted fix. Specifically:

1. **Style / naming / formatting / idiom comments** — apply them. Match the
   reviewer's suggested style even if it's a matter of preference; consistency
   with the reviewer's convention takes priority here.
2. **Straightforward correctness, bug, or logic comments** — apply them.
3. **Architectural or structural change requests** (e.g. reorganizing modules,
   changing a function's signature/contract, altering data flow, touching
   public APIs) — first check whether making the change risks breaking
   existing functionality or call sites, or is a substantially larger change
   than the comment implies.
   - If it's safe to do within this fix pass, make it.
   - If it risks breaking things, or is too large in scope for this pass,
     do **not** make the change. Leave the code as-is and record why (see
     below) — reference specifically what would break or why it's out of
     scope, so a human can follow up.
4. If you're genuinely unsure whether the reviewer is correct (e.g. it's a
   subjective architectural opinion, or you disagree with the premise), it's
   fine to leave the code unchanged — just say so plainly in the reason.

### Required output: the summary report

When you've gone through every comment below, write a file at:

\`${summaryFilePath}\`

using **exactly** this format — one section per comment, in the same order
they appear below, using the exact \`discussion_id\` given for each:

\`\`\`
## Comment <discussion_id>
Status: Updated
Summary: One or two sentences describing the change you made.

## Comment <discussion_id>
Status: Not Updated
Reason: One or two sentences explaining why no change was made.
Reply:
\`\`\`
The exact reply text to post back to GitLab as a response to this thread —
written as if you (the developer) are replying to the reviewer directly.
Keep it concise and specific.
\`\`\`
\`\`\`

Notes on the format:
- Use \`Status: Updated\` when you changed the code. \`Summary:\` is for your
  own records / a human skimming the report — it is not posted to GitLab.
- Use \`Status: Not Updated\` when you left the code as-is. \`Reason:\` is your
  internal note; \`Reply:\` (inside the fenced block) is what actually gets
  posted back to the GitLab thread by a follow-up script, so make sure it
  reads naturally as a reply, not as a note-to-self.
- Every comment below must have a corresponding section in the summary file,
  with the \`discussion_id\` copied exactly.

---

`;

  const sections = items.map((item, idx) => formatItem(item, idx + 1));

  return header + sections.join('\n\n---\n\n');
}

function formatItem({ discussion, position, context }, index) {
  const filePath = context.filePath || position.new_path || position.old_path;
  const lineInfo = context.targetLine
    ? `line ${context.targetLine} (${context.side} side of diff)`
    : '(no single line — see thread)';

  const codeBlock = context.snippet
    ? '```\n' + context.snippet + '\n```'
    : '_Could not retrieve file content for this location (file may have been renamed, moved, or deleted since the comment was posted). Locate the relevant code manually using the thread text below._';

  return `## Comment ${index}

- **discussion_id:** \`${discussion.id}\`
- **file:** \`${filePath}\`
- **location:** ${lineInfo}

### Code context

${codeBlock}

### Review thread

${formatThread(discussion)}
`;
}

function buildSkippedMarkdown({ mr, skipped }) {
  const header = `# Skipped Comments — !${mr.iid} ${mr.title}

These code-review comments were NOT sent to the coding agent. Review them
manually if needed; re-run with --include-resolved / --include-replied to
have them included next time.

---

`;
  if (skipped.length === 0) {
    return header + '_Nothing was skipped._\n';
  }

  const sections = skipped.map(({ discussion, reason }) => {
    const first = discussion.notes[0];
    const filePath = first.position.new_path || first.position.old_path;
    const line = first.position.new_line ?? first.position.old_line;
    return `## discussion_id: \`${discussion.id}\`

- **file:** \`${filePath}\`${line ? ` (line ${line})` : ''}
- **reason skipped:** ${reason}

${formatThread(discussion)}
`;
  });

  return header + sections.join('\n---\n\n');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
