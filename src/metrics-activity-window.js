// Use the same local calendar hours as the heatmap, including its combined
// repeated autumn hour. Omit nonexistent spring hours and hours outside the
// selected window, rather than presenting their absence as zero activity.
export function activityHourChoices(row, window) {
  if (!row || !window) return []
  return Array.from({ length: 24 }, (_, hour) => hour).filter(hour => {
    const start = new Date(row.startMs)
    start.setHours(hour, 0, 0, 0)
    const end = new Date(row.startMs)
    end.setHours(hour + 1, 0, 0, 0)
    return start.getHours() === hour && start.getTime() < window.endMs && end.getTime() > window.startMs
  })
}
