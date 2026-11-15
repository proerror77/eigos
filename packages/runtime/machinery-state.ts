import { Conflict, digest } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import { processLogTarget } from '../ontology/process-definition.js';
import type { Database } from './database.js';

type StateFields = Record<string, { values: string[]; required: boolean }>;
type StateContract = Record<string, StateFields>;

/** Compile the same stored state properties that the published ProcessLog types observe. */
export function machineryStateContract(model: Ontology): StateContract {
  const types = new Map<string, Map<string, StateFields[string]>>();
  for (const type of model.objects.keys()) {
    const tracked = processLogTarget(model, type);
    if (!tracked) continue;
    const property = model.object(tracked.objectType).properties[tracked.property]!;
    if (property.derived) throw new Conflict('Machinery state must be a stored property');
    const fields = types.get(tracked.objectType) ?? new Map();
    fields.set(tracked.property, { values: property.schema.enum as string[], required: property.required });
    types.set(tracked.objectType, fields);
  }
  return Object.fromEntries([...types].map(([type, fields]) => [type, Object.fromEntries(fields)]));
}

export async function initializeMachineryStates(db: Database) {
  const schema = db.schema;
  await db.transaction(async client => {
    await db.query(`ALTER TABLE ${schema}.releases ADD COLUMN IF NOT EXISTS machinery_states jsonb;
      ALTER TABLE ${schema}.objects ADD COLUMN IF NOT EXISTS machinery_state_contract jsonb;
      ALTER TABLE ${schema}.scenario_objects ADD COLUMN IF NOT EXISTS machinery_state_contract jsonb;
      CREATE UNIQUE INDEX IF NOT EXISTS releases_machinery_projection ON ${schema}.releases ((coalesce(projection,digest)))
        WHERE machinery_states IS NOT NULL;`, [], client);

    const releases = (await db.query<{ digest: string; projection: string; body: unknown; machinery_states: StateContract | null }>(
      `SELECT digest,coalesce(projection,digest) AS projection,body,machinery_states FROM ${schema}.releases
        ORDER BY (machinery_states IS NOT NULL) DESC,created_at,digest`, [], client)).rows;
    const contracts = new Map<string, string>();
    for (const release of releases) {
      const contract = machineryStateContract(new Ontology(release.body, { published: true }));
      const fingerprint = digest(contract);
      const previous = contracts.get(release.projection);
      if ((previous && previous !== fingerprint) ||
          (release.machinery_states && digest(release.machinery_states) !== fingerprint)) {
        throw new Conflict('Published projection has inconsistent Machinery state contracts');
      }
      if (previous) continue;
      contracts.set(release.projection, fingerprint);
      if (!release.machinery_states) {
        await db.query(`UPDATE ${schema}.releases SET machinery_states=$2 WHERE digest=$1`, [release.digest, contract], client);
      }
    }

    // Leave every untracked row untouched. Existing tracked rows are checked when the constraints are installed.
    await db.query(`UPDATE ${schema}.objects item SET machinery_state_contract=publication.machinery_states->item.type
      FROM ${schema}.releases publication WHERE item.projection=coalesce(publication.projection,publication.digest)
        AND publication.machinery_states ? item.type
        AND item.machinery_state_contract IS DISTINCT FROM publication.machinery_states->item.type;
      UPDATE ${schema}.scenario_objects item SET machinery_state_contract=publication.machinery_states->item.type
      FROM ${schema}.scenarios scenario JOIN ${schema}.releases original ON original.digest=scenario.release
      JOIN ${schema}.releases publication ON coalesce(publication.projection,publication.digest)=coalesce(original.projection,original.digest)
      WHERE item.scenario_id=scenario.id AND item.owner=scenario.owner AND publication.machinery_states ? item.type
        AND item.machinery_state_contract IS DISTINCT FROM publication.machinery_states->item.type;`, [], client);

    await db.query(`CREATE OR REPLACE FUNCTION ${schema}.valid_machinery_states(properties jsonb, contract jsonb)
      RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
        SELECT contract IS NULL OR properties IS NULL OR (
          jsonb_typeof(properties)='object' AND NOT EXISTS(
            SELECT 1 FROM jsonb_each(contract) field(name,rule)
            WHERE CASE WHEN NOT (properties ? field.name) THEN (field.rule->>'required')::boolean
              ELSE jsonb_typeof(properties->field.name)<>'string' OR NOT (field.rule->'values' ? (properties->>field.name))
            END
          )
        )
      $$;
      CREATE OR REPLACE FUNCTION ${schema}.bind_machinery_states()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF TG_TABLE_NAME='objects' THEN
            SELECT publication.machinery_states->NEW.type INTO NEW.machinery_state_contract
              FROM ${schema}.releases publication WHERE coalesce(publication.projection,publication.digest)=NEW.projection
                AND publication.machinery_states IS NOT NULL;
          ELSE
            SELECT publication.machinery_states->NEW.type INTO NEW.machinery_state_contract
              FROM ${schema}.scenarios scenario JOIN ${schema}.releases original ON original.digest=scenario.release
              JOIN ${schema}.releases publication ON coalesce(publication.projection,publication.digest)=coalesce(original.projection,original.digest)
              WHERE scenario.id=NEW.scenario_id AND scenario.owner=NEW.owner AND publication.machinery_states IS NOT NULL;
          END IF;
          IF NOT FOUND THEN RAISE EXCEPTION 'Machinery state contract is unavailable for the projection'
            USING ERRCODE='check_violation';
          END IF;
          RETURN NEW;
        END
      $$;
      CREATE OR REPLACE FUNCTION ${schema}.keep_machinery_contract()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN
          IF TG_TABLE_NAME='scenarios' THEN
            IF OLD.release IS DISTINCT FROM NEW.release OR OLD.owner IS DISTINCT FROM NEW.owner
              THEN RAISE EXCEPTION 'Scenario owner and publication are immutable' USING ERRCODE='check_violation';
            END IF;
          ELSIF OLD.machinery_states IS NOT NULL AND (
            OLD.machinery_states IS DISTINCT FROM NEW.machinery_states OR
            coalesce(OLD.projection,OLD.digest) IS DISTINCT FROM coalesce(NEW.projection,NEW.digest)
          ) THEN RAISE EXCEPTION 'Published Machinery state contract is immutable' USING ERRCODE='check_violation';
          END IF;
          RETURN NEW;
        END
      $$;
      CREATE OR REPLACE TRIGGER keep_machinery_contract BEFORE UPDATE OF machinery_states,projection,digest
        ON ${schema}.releases FOR EACH ROW EXECUTE FUNCTION ${schema}.keep_machinery_contract();
      CREATE OR REPLACE TRIGGER keep_machinery_contract BEFORE UPDATE OF release,owner
        ON ${schema}.scenarios FOR EACH ROW EXECUTE FUNCTION ${schema}.keep_machinery_contract();
      CREATE OR REPLACE TRIGGER bind_machinery_states BEFORE INSERT OR UPDATE OF projection,type,machinery_state_contract
        ON ${schema}.objects FOR EACH ROW EXECUTE FUNCTION ${schema}.bind_machinery_states();
      CREATE OR REPLACE TRIGGER bind_machinery_states BEFORE INSERT OR UPDATE OF scenario_id,owner,type,machinery_state_contract
        ON ${schema}.scenario_objects FOR EACH ROW EXECUTE FUNCTION ${schema}.bind_machinery_states();`, [], client);
    for (const table of ['objects', 'scenario_objects']) {
      const relation = `${schema}.${table}`;
      const present = await db.query(
        `SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=$1::regclass AND conname='machinery_state_valid'`, [relation], client);
      if (present.rowCount) continue;
      const base = table === 'scenario_objects' ? ` AND ${schema}.valid_machinery_states(base_properties,machinery_state_contract)` : '';
      await db.query(`ALTER TABLE ${relation} ADD CONSTRAINT machinery_state_valid CHECK (
        machinery_state_contract IS NULL OR (${schema}.valid_machinery_states(properties,machinery_state_contract)${base})
      )`, [], client);
    }
  });
}
