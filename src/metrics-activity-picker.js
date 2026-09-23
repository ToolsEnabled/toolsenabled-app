import { activityHourChoices } from './metrics-activity-window.js'
export { activityHourChoices } from './metrics-activity-window.js'
const dayLabel = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`


export function activityCount(reading, day, hour) {
  if (!reading?.ok || !Number.isInteger(hour) || hour < 0 || hour > 23) return null
  const index = reading?.rows?.findIndex(row => String(row.startMs) === String(day)) ?? -1
  const count = index < 0 ? undefined : reading.counts?.[index]?.[hour]
  return Number.isFinite(count) && count >= 0 ? count : null
}

export function createActivityPicker(host) {
  const doc = host.ownerDocument
  host.innerHTML = `<p class="m-activity-picker-title">Inspect activity by hour</p>
    <div class="m-activity-picker-field"><label for="activity-picker-day">Day</label><div class="m-activity-picker-row">
      <button type="button" class="ctl-btn" aria-label="Previous day">‹</button><select id="activity-picker-day"></select><button type="button" class="ctl-btn" aria-label="Next day">›</button>
    </div></div>
    <div class="m-activity-picker-field"><label for="activity-picker-hour">Hour</label><div class="m-activity-picker-row">
      <button type="button" class="ctl-btn" aria-label="Previous hour">‹</button><select id="activity-picker-hour"></select><button type="button" class="ctl-btn" aria-label="Next hour">›</button>
    </div></div>
    <p class="m-activity-picker-source"></p><p class="m-activity-picker-result" role="status" aria-live="polite" aria-atomic="true"></p>`
  const [day, hour] = host.querySelectorAll('select')
  const [previousDay, nextDay, previousHour, nextHour] = host.querySelectorAll('button')
  const result = host.querySelector('.m-activity-picker-result')
  const source = host.querySelector('.m-activity-picker-source')
  let reading, window, machine = '', example = false
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value }
  function options(select, entries) {
    const signature = JSON.stringify(entries)
    if (select.dataset.options === signature) return
    select.replaceChildren(...entries.map(([value, label]) => {
      const option = doc.createElement('option')
      option.value = String(value)
      option.textContent = label
      return option
    }))
    select.dataset.options = signature
  }
  function render() {
    const selectedDay = day.value
    const selectedHour = hour.value
    const rows = reading.rows.filter(row => activityHourChoices(row, window).length)
    host.hidden = !rows.length
    if (host.hidden) return
    options(day, rows.map(row => [row.startMs, dayLabel.format(new Date(row.startMs))]))
    day.value = rows.some(row => String(row.startMs) === selectedDay) ? selectedDay : String(rows.at(-1).startMs)
    const row = rows.find(row => String(row.startMs) === day.value)
    const hours = activityHourChoices(row, window)
    options(hour, hours.map(value => [value, hourLabel(value)]))
    hour.value = selectedHour !== '' && hours.includes(Number(selectedHour)) ? selectedHour : String(hours.at(-1))
    previousDay.disabled = day.selectedIndex === 0
    nextDay.disabled = day.selectedIndex === day.options.length - 1
    previousHour.disabled = hour.selectedIndex === 0
    nextHour.disabled = hour.selectedIndex === hour.options.length - 1
    text(source, example ? 'Example data · not your activity' : 'Recorded activity')
    const count = activityCount(reading, day.value, Number(hour.value))
    text(result, `${dayLabel.format(new Date(row.startMs))}, ${hourLabel(Number(hour.value))}: ${count === null ? 'No run count recorded.' : `${count.toLocaleString('en-US')} ${count === 1 ? 'run attempt' : 'run attempts'} recorded on ${machine}.`}`)
  }
  day.addEventListener('change', render)
  hour.addEventListener('change', render)
  for (const [button, select, direction] of [[previousDay, day, -1], [nextDay, day, 1], [previousHour, hour, -1], [nextHour, hour, 1]]) {
    button.addEventListener('click', () => {
      const next = select.selectedIndex + direction
      if (next < 0 || next >= select.options.length) return
      select.selectedIndex = next
      render()
    })
  }
  return {
    update(next, context) {
      reading = next
      window = context.window
      machine = context.machine
      example = context.example
      host.hidden = !reading?.ok
      if (!host.hidden) render()
    },
  }
}
