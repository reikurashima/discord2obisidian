import crypto from 'crypto';

// ---- Layout constants (PureRef-style: fixed row height + wrapping) ----
export const ROW_HEIGHT = 300;
export const MAX_ROW_WIDTH = 1800;
export const GAP = 20;

// Default dimensions used when the real image size is unknown.
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 300;

// YouTube (and other link) nodes use a fixed 16:9-ish card size.
const LINK_WIDTH = 533;
const LINK_HEIGHT = 300;

/**
 * Generate a JSON Canvas node id: 16 random hex chars.
 */
export function generateNodeId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Resolve the placed size of a single item, normalizing images to ROW_HEIGHT.
 * Returns { width, height }.
 */
function resolveSize(item) {
  if (item.kind === 'link') {
    return { width: LINK_WIDTH, height: LINK_HEIGHT };
  }

  // image
  const hasDims = Number.isFinite(item.width) && Number.isFinite(item.height)
    && item.width > 0 && item.height > 0;

  if (!hasDims) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }

  const width = Math.round(item.width * ROW_HEIGHT / item.height);
  return { width, height: ROW_HEIGHT };
}

/**
 * Build JSON Canvas nodes for a list of items, laying them out left-to-right
 * with fixed row height and wrapping.
 *
 * items: Array<{ kind: 'image', file, width, height } | { kind: 'link', url }>
 * start: { x, y, rowOccupied } starting position (used when appending to an
 *   existing canvas). rowOccupied indicates the row at (x, y) already has at
 *   least one node, so a first item that would overflow MAX_ROW_WIDTH still wraps.
 *
 * Returns an array of node objects (does not include edges).
 */
export function buildCanvasNodes(items, start = { x: 0, y: 0, rowOccupied: false }) {
  const nodes = [];
  let x = start.x;
  let y = start.y;
  let itemsInRow = start.rowOccupied ? 1 : 0;

  for (const item of items) {
    const { width, height } = resolveSize(item);

    // Wrap to a new row when the current one already has an item and this one
    // would overflow MAX_ROW_WIDTH. A single oversized item stays on its row.
    if (itemsInRow > 0 && x + width > MAX_ROW_WIDTH) {
      y += ROW_HEIGHT + GAP;
      x = 0;
      itemsInRow = 0;
    }

    if (item.kind === 'link') {
      nodes.push({ id: generateNodeId(), type: 'link', url: item.url, x, y, width, height });
    } else {
      nodes.push({ id: generateNodeId(), type: 'file', file: item.file, x, y, width, height });
    }

    x += width + GAP;
    itemsInRow += 1;
  }

  return nodes;
}

/**
 * Compute the starting position for appended nodes from a set of existing
 * nodes, so new items continue at the end of the last row instead of
 * wrapping to a new row on every append.
 *
 * Returns { x, y, rowOccupied }:
 * - No existing nodes: { x: 0, y: 0, rowOccupied: false } (fresh canvas).
 * - Otherwise: the last row is the set of nodes sharing the maximum y among
 *   existing nodes. x is set to max(x + width) + GAP within that row, y is
 *   that row's y, and rowOccupied is true (buildCanvasNodes' own wrapping
 *   logic still handles overflow into a new row from there).
 */
export function computeStartPosition(existingNodes) {
  if (!Array.isArray(existingNodes) || existingNodes.length === 0) {
    return { x: 0, y: 0, rowOccupied: false };
  }

  let maxY = -Infinity;
  for (const node of existingNodes) {
    const nodeY = Number(node.y) || 0;
    if (nodeY > maxY) maxY = nodeY;
  }

  let maxRight = 0;
  for (const node of existingNodes) {
    const nodeY = Number(node.y) || 0;
    if (nodeY !== maxY) continue;
    const right = (Number(node.x) || 0) + (Number(node.width) || 0);
    if (right > maxRight) maxRight = right;
  }

  return { x: maxRight + GAP, y: maxY, rowOccupied: true };
}
