#!/usr/bin/env bash
# gh_pr_threads.sh — Fetch PR review threads as structured payload for agent handoff
#
# Usage:
#   .kilocode/tools/gh_pr_threads.sh [PR_NUMBER]
#
# If PR_NUMBER is omitted, discovers the PR for the current branch.
#
# Output: JSON payload to stdout containing:
#   - PR metadata (number, title, branch, state)
#   - Review comments (file-level, threaded)
#   - PR-level review bodies
#   - Changed files list
#
# Designed for zero-LLM-cost data gathering — run this, pipe output to a file,
# then hand the file to an orchestrator subtask.

set -euo pipefail

PR_NUMBER="${1:-}"

# Discover repo owner/name
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# Discover PR if not provided
if [[ -z "$PR_NUMBER" ]]; then
  BRANCH=$(git branch --show-current)
  PR_NUMBER=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || true)
  if [[ -z "$PR_NUMBER" ]]; then
    echo "ERROR: No PR found for branch '$BRANCH'" >&2
    exit 1
  fi
fi

# Temporary files
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

# 1. PR metadata (uses gh pr view --json with known-good fields)
gh pr view "$PR_NUMBER" --json number,title,url,headRefName,baseRefName,state,author,body \
  > "$TMPDIR_WORK/meta.json"

# 2. Review comments (file-level inline comments, threaded via in_reply_to_id)
#    Uses REST API: GET /repos/{owner}/{repo}/pulls/{number}/comments
gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --paginate \
  > "$TMPDIR_WORK/review_comments.json"

# 3. PR-level reviews (approve/request changes/comment bodies)
gh pr view "$PR_NUMBER" --json reviews \
  > "$TMPDIR_WORK/reviews.json"

# 4. Changed files
gh pr view "$PR_NUMBER" --json files \
  > "$TMPDIR_WORK/files.json"

# 5. Issue-level comments (non-inline discussion)
gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate \
  > "$TMPDIR_WORK/issue_comments.json"

# Assemble payload
python3 -c "
import json, sys, os
from collections import defaultdict

tmpdir = sys.argv[1]

def load(name):
    with open(os.path.join(tmpdir, name)) as f:
        return json.load(f)

meta = load('meta.json')
review_comments = load('review_comments.json')
reviews = load('reviews.json')
files = load('files.json')
issue_comments = load('issue_comments.json')

# Group inline comments into threads (by in_reply_to_id or self)
threads = defaultdict(list)
for c in review_comments:
    thread_id = c.get('in_reply_to_id') or c['id']
    threads[thread_id].append({
        'id': c['id'],
        'user': c['user']['login'],
        'body': c['body'],
        'path': c.get('path', ''),
        'line': c.get('line') or c.get('original_line'),
        'side': c.get('side', ''),
        'created_at': c['created_at'],
        'diff_hunk': c.get('diff_hunk', ''),
    })

# Determine which threads look unresolved (heuristic: no bot/author resolution marker)
thread_list = []
for tid, comments in sorted(threads.items()):
    thread_list.append({
        'thread_id': tid,
        'path': comments[0]['path'],
        'line': comments[0]['line'],
        'comments': comments,
        'comment_count': len(comments),
    })

changed_files = [f['path'] for f in files.get('files', [])]

payload = {
    'pr': meta,
    'changed_files': changed_files,
    'thread_summary': {
        'total_threads': len(thread_list),
        'total_inline_comments': len(review_comments),
        'total_issue_comments': len(issue_comments),
    },
    'inline_threads': thread_list,
    'reviews': reviews.get('reviews', []),
    'issue_comments': [
        {
            'user': c['user']['login'],
            'body': c['body'],
            'created_at': c['created_at'],
        }
        for c in issue_comments
    ],
}

json.dump(payload, sys.stdout, indent=2)
print()
" "$TMPDIR_WORK"
