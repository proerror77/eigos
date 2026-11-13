import { Ontology } from '../ontology/model.js';
import { Database } from './database.js';

export class Metadata {
  private readonly models = new Map<string, Ontology>();
  constructor(private readonly db: Database) {}
  async publish(input: unknown): Promise<Ontology> {
    const model = new Ontology(input);
    await this.db.transaction(async client => {
      await this.db.query(`INSERT INTO ${this.db.schema}.releases(digest,body) VALUES($1,$2) ON CONFLICT DO NOTHING`, [model.digest, model.document], client);
      await this.db.query(`INSERT INTO ${this.db.schema}.ontology(id,release) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET release=excluded.release`, [model.document.id, model.digest], client);
    });
    this.models.set(model.digest, model);
    return model;
  }
  async active(id = 'Eigos'): Promise<Ontology> {
    const result = await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new Error('Publish the ontology before starting the runtime');
    return this.get(String(result.rows[0].release));
  }
  async get(release: string): Promise<Ontology> {
    const cached = this.models.get(release);
    if (cached) return cached;
    const result = await this.db.query(`SELECT body FROM ${this.db.schema}.releases WHERE digest=$1`, [release]);
    if (!result.rows[0]) throw new Error('Ontology release is unavailable');
    const model = new Ontology(result.rows[0].body);
    if (model.digest !== release) throw new Error('Ontology release content differs');
    if (this.models.size >= 16) this.models.delete(this.models.keys().next().value!);
    this.models.set(release, model);
    return model;
  }
}
