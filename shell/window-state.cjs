'use strict'

const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const DEFAULT_MIN_WIDTH = 980
const DEFAULT_MIN_HEIGHT = 640
const MAX_FALLBACK_DIMENSION = 16_384
const MIN_VISIBLE_EDGE = 64
const THEMES = new Set(['white', 'tan', 'black', 'ember', 'cobalt'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function shellStateRecord(value) {
  return isRecord(value) ? value : {}
}

function integerBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function normalizedWorkArea(value) {
  if (!isRecord(value)) return null
  if (!integerBetween(value.x, -2_147_483_648, 2_147_483_647)) return null
  if (!integerBetween(value.y, -2_147_483_648, 2_147_483_647)) return null
  if (!integerBetween(value.width, 1, 2_147_483_647)) return null
  if (!integerBetween(value.height, 1, 2_147_483_647)) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function overlap(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

function visibleOn(rect, area) {
  const intersection = overlap(rect, area)
  return intersection.width >= Math.min(MIN_VISIBLE_EDGE, rect.width)
    && intersection.height >= Math.min(MIN_VISIBLE_EDGE, rect.height)
}

function bestVisibleArea(rect, areas) {
  let best = null
  let bestOverlap = -1
  for (const area of areas) {
    if (!visibleOn(rect, area)) continue
    const intersection = overlap(rect, area)
    const score = intersection.width * intersection.height
    if (score > bestOverlap) {
      best = area
      bestOverlap = score
    }
  }
  return best
}

function coveredByAreas(rect, areas) {
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const xEdges = new Set([rect.x, right])
  for (const area of areas) {
    const left = Math.max(rect.x, area.x)
    const edge = Math.min(right, area.x + area.width)
    if (left < edge) {
      xEdges.add(left)
      xEdges.add(edge)
    }
  }

  const sortedEdges = [...xEdges].sort((left, edge) => left - edge)
  for (let index = 0; index < sortedEdges.length - 1; index += 1) {
    const left = sortedEdges[index]
    const edge = sortedEdges[index + 1]
    if (left === edge) continue
    const intervals = areas
      .filter((area) => area.x <= left && area.x + area.width >= edge)
      .map((area) => [Math.max(rect.y, area.y), Math.min(bottom, area.y + area.height)])
      .filter(([top, lowerEdge]) => top < lowerEdge)
      .sort(([top], [nextTop]) => top - nextTop)
    let coveredUntil = rect.y
    for (const [top, lowerEdge] of intervals) {
      if (top > coveredUntil) break
      coveredUntil = Math.max(coveredUntil, lowerEdge)
      if (coveredUntil >= bottom) break
    }
    if (coveredUntil < bottom) return false
  }
  return true
}

function fitIn(area, x, y, width, height) {
  return {
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(y, area.y, area.y + area.height - height),
  }
}

function centerIn(area, width, height) {
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
  }
}

function restoredWindowState(value, workAreas = []) {
  const state = shellStateRecord(value)
  const areas = Array.isArray(workAreas)
    ? workAreas.map(normalizedWorkArea).filter(Boolean)
    : []
  const primary = areas[0] || null
  const largestWidth = areas.length > 0
    ? Math.max(...areas.map((area) => area.width))
    : MAX_FALLBACK_DIMENSION
  const largestHeight = areas.length > 0
    ? Math.max(...areas.map((area) => area.height))
    : MAX_FALLBACK_DIMENSION
  const requestedWidth = integerBetween(state.width, 1, MAX_FALLBACK_DIMENSION)
    ? state.width
    : DEFAULT_WIDTH
  const requestedHeight = integerBetween(state.height, 1, MAX_FALLBACK_DIMENSION)
    ? state.height
    : DEFAULT_HEIGHT
  const candidateWidth = clamp(requestedWidth, Math.min(DEFAULT_MIN_WIDTH, largestWidth), largestWidth)
  const candidateHeight = clamp(requestedHeight, Math.min(DEFAULT_MIN_HEIGHT, largestHeight), largestHeight)
  const hasCoordinates = integerBetween(state.x, -2_147_483_648, 2_147_483_647)
    && integerBetween(state.y, -2_147_483_648, 2_147_483_647)
  const candidate = hasCoordinates
    ? { x: state.x, y: state.y, width: candidateWidth, height: candidateHeight }
    : null
  const target = candidate ? bestVisibleArea(candidate, areas) : null

  if (target) {
    const minWidth = Math.min(DEFAULT_MIN_WIDTH, target.width)
    const minHeight = Math.min(DEFAULT_MIN_HEIGHT, target.height)
    const width = clamp(candidate.width, minWidth, target.width)
    const height = clamp(candidate.height, minHeight, target.height)
    return {
      theme: THEMES.has(state.theme) ? state.theme : 'white',
      maximized: state.maximized === true,
      bounds: {
        ...(coveredByAreas({ ...candidate, width, height }, areas)
          ? { x: candidate.x, y: candidate.y }
          : fitIn(target, candidate.x, candidate.y, width, height)),
        width,
        height,
        minWidth,
        minHeight,
      },
    }
  }

  if (primary) {
    const minWidth = Math.min(DEFAULT_MIN_WIDTH, primary.width)
    const minHeight = Math.min(DEFAULT_MIN_HEIGHT, primary.height)
    const width = clamp(requestedWidth, minWidth, primary.width)
    const height = clamp(requestedHeight, minHeight, primary.height)
    return {
      theme: THEMES.has(state.theme) ? state.theme : 'white',
      maximized: state.maximized === true,
      bounds: {
        ...centerIn(primary, width, height),
        width,
        height,
        minWidth,
        minHeight,
      },
    }
  }

  return {
    theme: THEMES.has(state.theme) ? state.theme : 'white',
    maximized: state.maximized === true,
    bounds: {
      width: clamp(requestedWidth, DEFAULT_MIN_WIDTH, MAX_FALLBACK_DIMENSION),
      height: clamp(requestedHeight, DEFAULT_MIN_HEIGHT, MAX_FALLBACK_DIMENSION),
      minWidth: DEFAULT_MIN_WIDTH,
      minHeight: DEFAULT_MIN_HEIGHT,
    },
  }
}

module.exports = {
  DEFAULT_HEIGHT,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_WIDTH,
  DEFAULT_WIDTH,
  restoredWindowState,
  shellStateRecord,
}
