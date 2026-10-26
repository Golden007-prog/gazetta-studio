/** Matches `write-file-atomic@8`'s engines requirement, so our own engines gate rejects an unsupported Node before the transitive dep's EBADENGINE does. */
export const REQUIRED_NODE_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0'
