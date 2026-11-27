import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RepositoryReader } from './source-reader.js';

const read = z.strictObject({ path: z.string(), start: z.int().min(1).default(1), limit: z.int().min(1).max(500).default(200) });
const schemas = {
  list_files: z.strictObject({}),
  read_file: read,
  read_base_file: read,
  search_text: z.strictObject({ term: z.string().min(1).max(200) }),
};
export const snapshotToolDefinitions = Object.entries(schemas).map(([name, args]) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(args);
  return { name, description: `Read-only snapshot tool: ${name}`, parameters };
});

export class SnapshotTools {
  readonly #source: RepositoryReader;
  readonly #base: RepositoryReader;
  #readSource = false;

  constructor(source: string) {
    this.#source = new RepositoryReader(source);
    this.#base = new RepositoryReader(join(dirname(source), 'base'));
  }

  get readSource(): boolean { return this.#readSource; }

  async run(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case 'list_files':
        schemas.list_files.parse(args);
        return this.#source.list();
      case 'read_file':
      case 'read_base_file': {
        const { path, start, limit } = read.parse(args);
        const file = await (name === 'read_file' ? this.#source : this.#base).read(path, start, limit);
        if (name === 'read_file' && file.lines.length) this.#readSource = true;
        return file;
      }
      case 'search_text':
        return this.#source.search(schemas.search_text.parse(args).term);
      default:
        throw new Error('Unknown snapshot tool');
    }
  }
}
