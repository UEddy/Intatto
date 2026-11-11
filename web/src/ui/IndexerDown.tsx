import type { IndexerUnavailableError } from "../indexer/resilient";

/**
 * Shown when no indexer can answer. Each source's own reason is listed, so a failure on the live
 * site can be read off the page: "fastnear: network error (…)", "nearblocks cannot list …".
 */
export function IndexerDown({ error }: { error: IndexerUnavailableError }) {
  return (
    <div className="empty indexer-down" role="status">
      <p>The transaction indexers are not answering right now. The page keeps retrying, backing off between tries.</p>
      {error.errors.length > 0 ? (
        <ul className="indexer-reasons mono">
          {error.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
