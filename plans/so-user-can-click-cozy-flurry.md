# Plan: Dashboard / Reports mode switcher

## Context

The BarChart icon in LeftNav (line 333) is currently always active and does nothing. Clicking it should open a dark popup menu with two options — Dashboard and Reports — matching image-20. Selecting Reports stays on the current pivot report builder. Selecting Dashboard switches to a new dashboard view (image-21): a full-page dashboard UI with a header, filter toolbar, KPI tiles, bar charts, and a grid of widgets.

---

## What Changes

Single file: **`src/App.tsx`**

---

## 1. App-level `appMode` state

Add to App root:
```typescript
const [appMode, setAppMode] = useState<"reports" | "dashboard">("reports")
```

Pass `appMode` and `setAppMode` down to `LeftNav`.

---

## 2. LeftNav — mode switcher popup

`LeftNav` receives `{ appMode, setAppMode }` props. The BarChart NavBtn gets an `onClick` that toggles a local `showModeMenu` boolean state.

When `showModeMenu` is true, render a dark popup panel (`bg-gray-900 text-white rounded-xl shadow-2xl py-3 w-52`) absolutely positioned to the right of the BarChart button. Two rows:

```
[📊 icon]  Dashboard
[📈 icon]  Reports
```

Each row: `flex items-center gap-3 px-4 py-3 text-[15px] hover:bg-white/10 rounded-lg cursor-pointer`. Clicking either sets `appMode` and closes the menu. A fixed transparent backdrop closes it on outside click.

The BarChart NavBtn `active` prop becomes `true` always (it's the analytics section), styled indigo as before.

---

## 3. Dashboard view — `DashboardView` component

When `appMode === "dashboard"`, render `<DashboardView />` instead of the full pivot builder (FieldBrowser + DropZoneBar + FilterBar + ReportCanvas).

### Layout

```
<DashboardView>
  <DashboardHeader />      ← title + New dashboard + Add new widget buttons
  <DashboardToolbar />     ← Dashboard chip | Filter | Date range | Show values toggle | Share
  <DashboardCanvas />      ← scrollable grid of widgets
</DashboardView>
```

The LeftNav and the right column wrapper stay the same — only the contents of the right column change based on `appMode`. `PageHeader` is hidden when in dashboard mode (the dashboard has its own header).

### DashboardHeader (matches image-21 top bar)
- Left: hamburger icon + "My First Dashboard" h1 (lg, semibold)
- Right: "New dashboard +" button (gray border) + "Add new widget +" button (dark bg)

### DashboardToolbar
- `[📊 Dashboard]` pill chip (gray border, small icon)
- `[🔽 Filter]` button
- `[📅 05 Aug 25 – 05 Aug 26 (Last 12 months)]` date button
- `[toggle] Show values in charts` toggle switch (right-aligned)
- `[Share ▾]` button (dark bg)

### DashboardCanvas — widget grid

A scrollable area with a responsive grid of mock widgets:

**Row 1 — KPI tile (full width)**
- "Projects In-Progress" label with a sort icon
- Large centered number: `1` (display font, 64px)

**Row 2 — 3 bar chart widgets side by side**
Each widget card: white bg, border, rounded-xl, p-4, shadow-sm
1. **Project by Status** — bars: Proposed (blue), In progress (green), x-axis = Status
2. **Status by Phase** — bars: Completed, In progress, +2 more; x-axis = Phase (Handoff, Inprogress, Migration)
3. **Task by status** — bars: To do (blue), Completed (green), Overdue (red); x-axis = Status

Charts are SVG-drawn bar charts — no external library. Each chart: legend dots + labels at top, axes drawn with lines, bars as `<rect>` elements with rounded tops, axis labels below. Heights and values taken directly from image-21 proportions (small numbers: 1–20 range).

**Row 3 — 2 widgets side by side**
- "Projects Running late" — empty card with sort icon (data pending placeholder)
- "Projects Overdue" — empty card with sort icon

---

## 4. App root render change

```tsx
// in App return, inside the right column:
{appMode === "dashboard" ? (
  <DashboardView />
) : (
  <>
    <PageHeader />
    <Toolbar … />
    <div className="flex flex-1 overflow-hidden">
      <FieldBrowser … />
      <div className="flex flex-col flex-1 min-w-0">
        <DropZoneBar … />
        <FilterBar … />
        <ReportCanvas … />
      </div>
    </div>
  </>
)}
```

---

## Verification

1. Click BarChart icon in LeftNav → dark popup with Dashboard + Reports rows appears.
2. Click **Reports** → menu closes, stays on pivot builder (no change).
3. Click **Dashboard** → menu closes, full dashboard view replaces the pivot builder.
4. Dashboard shows header, toolbar, KPI tile, 3 bar charts, 2 placeholder cards.
5. Click BarChart again → menu reopens; clicking Reports switches back to pivot builder.
6. Outside click on backdrop closes the menu without switching mode.

---

## File Changed

Single file: **`src/App.tsx`** — only the `FilterChip` component and `FilterRule` type are affected.

---

## FilterRule type additions

Add three new fields to `FilterRule` to hold date-specific state:

```typescript
interface FilterRule {
  // existing fields unchanged ...
  // new:
  dateMode: "actual" | "range" | "relative"   // which tab is active
  dateGranularity: string                      // active granularity label (Actual / Relative tabs)
  dateRelativeOpt: string                      // selected relative option key
  dateRelativeN: number                        // numeric input for Last N / Next N
  dateIncludeNull: boolean                     // include null values toggle
  dateRangeOp: "after" | "before" | "between" // for Range tab
  dateFrom: string                             // ISO date string
  dateTo: string                               // ISO date string (between only)
}
```

Default when a date field is dropped: `dateMode: "actual"`, `dateGranularity: "Month & Year"`, everything else empty/false.

---

## DateFilterModal component

A new component `DateFilterModal` replaces the generic filter panel when `rule.type === "date"`. It renders as a fixed-position centered modal overlay (not a dropdown) — `fixed inset-0 z-60 flex items-center justify-center` with a semi-transparent backdrop. Modal card is `w-[560px]` with a header, three tab buttons, and mode body.

### Header
```
[📅 icon]  Due Date                         [×]
```
Field name + close button. Below the header, three pill-tab buttons:
```
[ Actual Data ]  [ Range ]  [ Relative ]
```
Active tab is indigo filled, inactive are gray outlines.

---

### Tab 1 — Actual Data

Left sidebar: vertical list of granularity options from `DATE_GRANULARITY` (the existing 9-item constant). Clicking a granularity updates `dateGranularity`. Active item highlighted indigo.

Right content panel: shows multi-select checkboxes of mock values for the selected granularity. Values are generated from `ACTUAL_DATE_VALUES` — a new constant mapping each granularity label to a list of representative strings:

```typescript
const ACTUAL_DATE_VALUES: Record<string, string[]> = {
  "Year":           ["2022", "2023", "2024", "2025", "2026"],
  "Quarter & Year": ["Q1 2025", "Q2 2025", "Q3 2025", "Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026"],
  "Quarter":        ["Q1", "Q2", "Q3", "Q4"],
  "Month & Year":   ["Jan 2025", "Feb 2025", ..., "Aug 2026"],   // 18 months
  "Month":          ["January", "February", ..., "December"],
  "Week & Year":    ["W1 2026", "W2 2026", ..., "W32 2026"],     // last 32 weeks
  "Week":           ["Week 1", "Week 2", ..., "Week 52"],
  "Date":           ["2026-07-01", ..., "2026-08-04"],            // last 35 days
  "Date & Time":    ["2026-08-04 00:00", ..., "2026-08-04 23:00"],// 24 hours
}
```

Search input above the list (same style as existing filter picker). Select All / None controls. Checkbox list (max-h-64, scrollable). Selections stored in `rule.values`.

Include null values toggle at the bottom: `[ ] Include null values` — updates `dateIncludeNull`.

---

### Tab 2 — Range

Three operator buttons: `After` · `Before` · `Between` — stored in `dateRangeOp`.

**After**: single `<input type="date">` labeled "After date" → `dateFrom`  
**Before**: single `<input type="date">` labeled "Before date" → `dateFrom`  
**Between**: two date inputs side-by-side — "From" (`dateFrom`) and "To" (`dateTo`)

Include null values toggle at the bottom.

---

### Tab 3 — Relative

Left sidebar: granularity list — same `DATE_GRANULARITY` items. Active selection updates `dateGranularity`.

Right content panel: shows relative options for the selected granularity. Options are defined in a new constant `RELATIVE_OPTIONS`:

```typescript
// Per granularity, available relative options:
"Year":           ["This year", "Last year", "Next year", "Last N years", "Next N years"]
"Quarter":        ["This quarter", "Last quarter", "Next quarter", "Last N quarters", "Next N quarters"]
"Quarter & Year": [same as Quarter]
"Month":          ["This month", "Last month", "Next month", "Last N months", "Next N months"]
"Month & Year":   [same as Month]
"Week":           ["This week", "Last week", "Next week", "Last N weeks", "Next N weeks"]
"Week & Year":    [same as Week]
"Date":           ["Today", "Yesterday", "Tomorrow", "Last N days", "Next N days", "Day to date"]
"Date & Time":    ["Now", "Last N hours", "Next N hours", "Today", "Yesterday"]
```

Each option renders as a radio button. Options ending in "Last N …" / "Next N …" show an inline number input (stepper, min 1). Selected option stored in `dateRelativeOpt`, N stored in `dateRelativeN`.

Include null values toggle at the bottom.

---

## Chip pill summary (updated)

For date fields, the chip pill summary shows:
- **Actual**: `{dateGranularity} · {N} selected` or `{dateGranularity} · {value}` if 1
- **Range**: `{dateRangeOp} {dateFrom}` or `{dateFrom} – {dateTo}`
- **Relative**: `{dateRelativeOpt}` (truncated)

---

## Modal trigger

In `FilterChip`, when `rule.type === "date"` and `open === true`, render `<DateFilterModal>` instead of the existing inline panel. The modal is rendered via a React portal into `document.body` to avoid z-index stacking issues with the filter bar.

Non-date fields continue to use the existing inline panel unchanged.

---

## Verification

1. Drop a date field (e.g. "Due Date") into the Filter bar → modal opens centered on screen.
2. Three tabs visible: Actual Data (default active), Range, Relative.
3. **Actual**: granularity sidebar works; selecting "Month & Year" shows month+year checkboxes; search filters list; Select All / None work; chip pill updates summary.
4. **Range**: clicking After shows one date input; Between shows two; chip pill shows range summary.
5. **Relative**: granularity sidebar works; "Last N days" shows number stepper; chip pill shows relative summary.
6. Include null toggle persists across tab switches.
7. Apply closes modal; Clear resets all date state.
8. Non-date field chips (text, number, person) are completely unaffected.
