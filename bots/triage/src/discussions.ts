import type { GitHubApi } from './run.js';

/**
 * DISCUSSIONS SPEAK GRAPHQL ONLY.
 *
 * There is no REST endpoint for Discussions — not for reading one, not for listing its comments,
 * not for posting to it. GitHub's REST API covers issues and pull requests; Discussions exist only
 * in the GraphQL schema. That is the entire reason this file exists rather than a few more methods
 * on the REST client in `main.ts`, and it is worth stating because "just use the issues endpoint"
 * is the obvious wrong guess and it fails at runtime with a 404 that reads like a permissions bug.
 *
 * This adapter presents the same `GitHubApi` shape the issue path uses, so `run.ts` — which holds
 * every decision — does not know or care which surface it is on. The mapping is not perfect and
 * the imperfections are handled honestly rather than papered over:
 *
 *   - **Labels.** Discussions support labels, but applying them needs the label's node ID, not its
 *     name, which is a second round trip for something nobody triages a discussion by. This
 *     adapter does not label discussions, and says so by returning without acting rather than by
 *     throwing — a discussion that gets a correct answer and no label is a fine outcome; one that
 *     fails to post because labelling failed is not.
 *   - **The daily cap** is shared with the issue path deliberately. The cap exists to bound how
 *     much noise a broken trigger can make across the whole repository, and a per-surface cap
 *     would let a loop on discussions run at full rate while issues looked healthy. The REST
 *     comment listing does not see discussion comments, so the count is a floor, not an exact
 *     figure — noted here rather than presented as precision it does not have.
 *   - **`state`** maps from `closed` / `isAnswered`. An answered discussion is somebody's
 *     conclusion, and the conversation guard already refuses closed threads; this makes "answered"
 *     mean closed too, which is the fail-closed reading.
 */

export interface GraphQLClient {
  (query: string, variables: Record<string, unknown>): Promise<unknown>;
}

/** The default client: one POST to /graphql with the job token. */
export function makeGraphQLClient(token: string): GraphQLClient {
  return async (query, variables) => {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'usewarden-triage-bot',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL -> ${res.status}`);
    const j = await res.json() as { data?: unknown; errors?: { message: string }[] };
    // GraphQL returns 200 with an `errors` array. Treating that as success is how a bot ends up
    // reporting that it posted something it did not post.
    if (j.errors?.length) throw new Error(`GitHub GraphQL: ${j.errors.map((e) => e.message).join('; ')}`);
    return j.data;
  };
}

const READ = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    discussion(number:$number) {
      id
      number
      title
      body
      closed
      isAnswered
      author { login __typename }
      comments(first:100) {
        nodes { body author { login __typename } }
      }
    }
  }
}`;

const POST = `
mutation($discussionId:ID!, $body:String!) {
  addDiscussionComment(input:{discussionId:$discussionId, body:$body}) {
    comment { id }
  }
}`;

interface DiscussionAuthor { login?: string; __typename?: string }
interface DiscussionNode {
  id: string; number: number; title: string | null; body: string | null;
  closed: boolean; isAnswered: boolean | null;
  author: DiscussionAuthor | null;
  comments: { nodes: { body: string | null; author: DiscussionAuthor | null }[] };
}

/** GraphQL reports a bot as `__typename: "Bot"`. The `[bot]` suffix is the belt to that braces. */
const isBotAuthor = (a: DiscussionAuthor | null): boolean =>
  a?.__typename === 'Bot' || /\[bot\]$/.test(a?.login ?? '');

/**
 * A `GitHubApi` backed by Discussions.
 *
 * `restCap` is the issue path's daily counter, reused rather than reimplemented — see the note
 * above on why the cap is deliberately shared and why it is a floor.
 */
export function discussionApi(
  gql: GraphQLClient,
  repo: string,
  restCap: () => Promise<number>,
  log: (s: string) => void = () => { /* quiet */ },
): GitHubApi {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`discussionApi: expected owner/name, got ${JSON.stringify(repo)}`);

  // One read serves both getIssue() and listIssueComments(); caching it avoids a second identical
  // round trip and, more importantly, guarantees both see the SAME snapshot. A guard that decides
  // from one snapshot and posts against another is a guard with a race in it.
  let cached: DiscussionNode | null = null;
  const read = async (n: number): Promise<DiscussionNode> => {
    if (cached && cached.number === n) return cached;
    const data = await gql(READ, { owner, name, number: n }) as
      { repository?: { discussion?: DiscussionNode | null } | null };
    const d = data?.repository?.discussion;
    if (!d) throw new Error(`discussion #${n} not found in ${repo}`);
    cached = d;
    return d;
  };

  return {
    async getIssue(n) {
      const d = await read(n);
      return {
        number: d.number,
        title: d.title ?? '',
        body: d.body ?? '',
        user: d.author?.login ?? '',
        // An ANSWERED discussion is closed as far as the bot is concerned. Fail-closed reading.
        state: d.closed || d.isAnswered ? 'closed' : 'open',
        labels: [],
      };
    },
    async listIssueComments(n) {
      const d = await read(n);
      return d.comments.nodes.map((c) => ({
        user: c.author?.login ?? '',
        isBot: isBotAuthor(c.author),
        body: c.body ?? '',
      }));
    },
    async createComment(n, body) {
      const d = await read(n);
      await gql(POST, { discussionId: d.id, body });
    },
    async addLabels(_n, labels) {
      // Deliberately inert. See the header: labelling a discussion needs node IDs, and failing to
      // post a correct answer because a label lookup failed is the worse trade.
      if (labels.length > 0) log(`labels not applied on a discussion surface: ${labels.join(',')}`);
    },
    countRecentBotComments: restCap,
  };
}
