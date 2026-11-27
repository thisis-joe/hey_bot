import { randomUUID, createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InitialQuestionsSchema, Sha, emptyReport, type Report } from './contracts.js';
import { sameRevision } from './learning.js';
import type { Platform } from './platform.js';
import { redact } from './redact.js';
import { SUMMARY_MARKER, renderReport, renderReveal, renderQuestionThread, summaryMarker } from './render.js';
import { generateQuestions, type Model, type DiffPosition } from './review.js';
import type { Workspaces } from './workspace.js';

const TrialRevision = z.strictObject({
  platform: z.enum(['github', 'gitlab']), instance: z.string().url(), repository: z.string().min(1),
  number: z.int().positive(), headSha: Sha, baseSha: Sha, startSha: Sha,
});
const Trial = z.strictObject({
  snapshot: TrialRevision, questions: z.string().min(1).max(58000), explanations: z.string().max(60000),
  items: InitialQuestionsSchema.shape.questions,
  anchors: z.array(z.strictObject({ path: z.string(), oldPath: z.string(), oldLine: z.int().positive().optional(), newLine: z.int().positive().optional() }).nullable()).length(2),
});
type Trial = z.infer<typeof Trial>;
type Prepare = Pick<Workspaces, 'prepare' | 'root'>;
type ReadTrial = Pick<Platform, 'permission' | 'snapshot'>;
type PublishTrial = Pick<Platform, 'permission' | 'snapshot' | 'comments' | 'owned' | 'comment' | 'inlineComments' | 'inline'>;

async function requireMaintainer(platform: ReadTrial, reviewer: string): Promise<void> {
  if (await platform.permission(reviewer) !== 'maintain') throw new Error('Repository maintainer permission required');
}

function questionsOnly(report: Report): string {
  const reserved = new Set([SUMMARY_MARKER, summaryMarker(report.snapshot)]);
  return renderReport(report).split('\n').filter(line => !reserved.has(line)).join('\n');
}

export async function previewRepositoryTrial({ platform, workspaces, model, number, reviewer }: {
  platform: Platform;
  workspaces: Prepare;
  model: Model;
  number: number;
  reviewer: string;
}): Promise<Trial> {
  await requireMaintainer(platform, reviewer);
  const snapshot = await platform.snapshot(number);
  snapshot.title = redact(snapshot.title);
  snapshot.description = redact(snapshot.description);
  const job = randomUUID();
  try {
    const { context, guidelines, policy } = await workspaces.prepare(platform, snapshot, job, null);
    const report = await generateQuestions(model, job, snapshot, policy, context, null, guidelines, [], 'full');
    if (!sameRevision(snapshot, await platform.snapshot(number))) throw new Error('Trial revision changed during preview');
    const { platform: provider, instance, repository, headSha, baseSha, startSha } = snapshot;
    return Trial.parse({
      snapshot: { platform: provider, instance, repository, number, headSha, baseSha, startSha },
      questions: questionsOnly(report),
      explanations: renderReveal(report.questions.map((q, i) => ({ q, label: `질문${i + 1}` })), snapshot, 'setup-preview'),
      items: report.questions,
      anchors: report.questions.map(q => {
        const entry = Object.entries(context.diff).find(([path, diff]) => q.side === 'LEFT' ? diff.oldPath === q.path : path === q.path);
        const position = entry?.[1].positions?.[q.side]?.[q.line];
        return entry && position ? { path: entry[0], oldPath: entry[1].oldPath, ...position } : null;
      }),
    });
  } finally {
    await rm(join(workspaces.root, 'jobs', job), { recursive: true, force: true });
  }
}

export async function publishRepositoryTrial({ platform, reviewer, number, draft, record }: {
  platform: PublishTrial;
  reviewer: string;
  number: number;
  draft: unknown;
  record: (report: Report, marker: string) => Promise<void>;
}): Promise<{ alreadyPublished: boolean }> {
  const trial = Trial.parse(draft);
  if (!trial.anchors.some(Boolean)) throw new Error('Choose a trial PR/MR with a changed line for the question thread');
  await requireMaintainer(platform, reviewer);
  const confirmRevision = async () => {
    const live = await platform.snapshot(number);
    if (live.number !== trial.snapshot.number || live.platform !== trial.snapshot.platform || live.instance !== trial.snapshot.instance ||
      live.repository !== trial.snapshot.repository || !sameRevision(live, trial.snapshot)) {
      throw new Error('Trial preview does not match this repository and revision');
    }
    return live;
  };
  const snapshot = await confirmRevision();
  snapshot.title = redact(snapshot.title);
  snapshot.description = redact(snapshot.description);
  const token = createHash('sha256').update(JSON.stringify([trial.snapshot, trial.items, trial.anchors])).digest('hex');
  const marker = `<!-- heybot:repository-trial:${token} -->`;
  const report = { ...emptyReport(snapshot, 'completed', ''), questions: trial.items, requireAnswers: false };
  await record(report, token);
  const alreadyPublished = (await platform.comments(number)).some(comment => platform.owned(comment) && comment.body.includes(marker));
  if (!alreadyPublished) {
    await confirmRevision();
    await platform.comment(number, `${marker}\n### Heybot 시험 출제\n\n${questionsOnly(report)}`);
  }
  const inline = await platform.inlineComments(number);
  for (const [index, question] of trial.items.entries()) {
    const anchor = trial.anchors[index];
    if (!anchor) continue;
    const body = renderQuestionThread(question, snapshot, index + 1);
    if (inline.some(comment => platform.owned(comment) && comment.body === body)) continue;
    await confirmRevision();
    const coordinates: DiffPosition = { oldLine: anchor.oldLine, newLine: anchor.newLine };
    await platform.inline(snapshot, { ...anchor, line: question.line, side: question.side, coordinates, suggestion: null, body });
  }
  return { alreadyPublished };
}
