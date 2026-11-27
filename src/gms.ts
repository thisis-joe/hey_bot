import { ResponsesModel } from './responses.js';
import type { InitialQuestionDraft } from './review.js';

export class Gms extends ResponsesModel {
  constructor(root: string, readonly url: string, readonly key: string, readonly model: string) {
    super(root, { provider: 'gms', url, key, model });
    if (!key || !model || !url) throw new Error('GMS_KEY, GMS_MODEL and GMS_RESPONSES_URL are required');
  }

  async initialQuestions(prompt: string, id: string, timeoutMs: number): Promise<InitialQuestionDraft> {
    return { output: await this.run('initial_questions', prompt, id, timeoutMs), verify: this.model === 'gpt-6-luna' };
  }
}
