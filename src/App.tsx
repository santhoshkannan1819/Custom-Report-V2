import { useState, useRef, useEffect, useLayoutEffect, useMemo, Fragment, createContext, useContext } from "react"
import { createPortal } from "react-dom"

// ── Types ──────────────────────────────────────────────────────────────────────

type FieldType = "number" | "date" | "text" | "person" | "money" | "hours" | "percent" | "boolean"
// The pivot builder's three shelves, plus the tabular builder's two. Distinct keys rather than
// reusing "columns" for both: a tabular column is a raw record field, a pivot column is a
// grouping dimension — same word, unrelated behaviour, and modifierOptions has to tell them apart.
// Kept as two narrow unions so each builder's handlers can index its own field object safely;
// ZoneKey is the wide union for components (DropZone, FieldChip) that serve both.
type PivotZoneKey = "columns" | "rows" | "values"
type TabularZoneKey = "tabColumns" | "tabGroupBy"
type ZoneKey = PivotZoneKey | TabularZoneKey
type ReportView = "detail" | "compact"
// "create" = the builder (source picker, field browser, Columns/Rows/Values drop areas all
// visible). "view" = the same report rendered read-only-ish, with all of those build-time
// controls hidden — just the configured table (plus Filters, still shown as-is).
type ReportMode = "create" | "view"
// The three things the Analytics nav switches between. Reports is the pivot builder; Tabular is
// a separate, flat report entity with its own state and saved payload.
type AppMode = "reports" | "dashboard" | "tabular"

interface Field {
  name: string
  type: FieldType
  /** One answer can hold several values (a checkbox question, a multi-user pick). Grouping on it
      puts a record under every value it has; totals still count the record once. */
  multi?: boolean
}

interface Module {
  name: string
  iconType: "project" | "account" | "time" | "metrics" | "task" | "people" | "misc"
  canBeSource: boolean
  fields: Field[]
}

// A dropped field is an *instance* — dropping the same field twice (e.g. two "Estimate to
// completion" pills with different aggregations, or two of the same time-tracked metric with
// different date ranges) must give each occurrence its own identity. `id` is that identity;
// `field` is the underlying "Module::Field Name" key. Per-pill state (aggregations, timeline
// filters) is keyed by `id`, never by `field` — otherwise duplicate pills would share state.
interface PivotItem {
  id: string
  field: string
}

interface PivotFields {
  columns: PivotItem[]
  rows: PivotItem[]
  values: PivotItem[]
}

// A Tabular report is a flat list of records — one row per record at the report's grain, with
// the chosen fields as columns. `groupBy` fields render as the LEFTMOST columns, each value
// shown once spanning the rows that share it. No aggregation anywhere: summarising is what the
// pivot builder is for.
interface TabularFields {
  columns: PivotItem[]
  groupBy: PivotItem[]
}

let pivotItemCounter = 0
function nextPivotItemId(): string {
  return `item-${pivotItemCounter++}`
}

// Dev only: Vite swaps this module on every hot update, which resets the counter to 0 while the
// React state that survived the update still holds ids minted from it. The next field dropped
// would then be handed an id a live chip already owns, and React warns about duplicate keys.
// Stashing the counter in the HMR data bag carries it across updates so ids stay unique for the
// life of the tab. No effect on a real page load, where the module is only ever evaluated once.
const viteHot = (import.meta as { hot?: { data: Record<string, unknown>; dispose: (cb: (data: Record<string, unknown>) => void) => void } }).hot
if (viteHot) {
  pivotItemCounter = (viteHot.data.pivotItemCounter as number) ?? 0
  viteHot.dispose((data) => { data.pivotItemCounter = pivotItemCounter })
}

// The counter restarts at 0 on every page load, so a restored report would otherwise hand out
// ids that collide with its own — and with the other report type's, since the pivot and tabular
// builders both draw from this counter and each restores from its own saved payload. Bumping
// past everything restored keeps every id unique for the life of the session.
function reserveItemIds(items: PivotItem[]): void {
  items.forEach(({ id }) => {
    const m = /^item-(\d+)$/.exec(id ?? "")
    if (m) pivotItemCounter = Math.max(pivotItemCounter, Number(m[1]) + 1)
  })
}

// ── Timeline metric constants ───────────────────────────────────────────────

interface TimelineGroup { group: string; metrics: string[] }

// Composite "Module::Field" keys — the same short name (e.g. "Actual Cost") exists on
// several modules in the real schema, so a bare name can't identify which one is meant.
const TIMELINE_GROUPS: TimelineGroup[] = [
  { group: "Allocations", metrics: ["Allocations::Allocated Hours", "Allocations::Hard Allocated Hours", "Allocations::Soft Allocated Hours"] },
  { group: "Actual financials", metrics: ["Actual financials::Actual Revenue", "Actual financials::Actual Cost", "Actual financials::Actual Margin", "Actual financials::Actual Profit"] },
  { group: "Estimated financials", metrics: ["Estimated financials::Estimated Revenue", "Estimated financials::Estimated Cost", "Estimated financials::Estimated Margin", "Estimated financials::Estimated Profit"] },
  { group: "Time tracking", metrics: ["Time tracking::Tracked Hours", "Time tracking::Billable Hours", "Time tracking::Non Billable Hours", "Time tracking::Bill rate", "Time tracking::Cost rate"] },
  { group: "Leave & holiday", metrics: ["Leave & holiday::Total Leave", "Leave & holiday::Holiday", "Leave & holiday::Timeoff"] },
]

// Declared up here, not with the rest of the Timeline code, because getFieldType reads it and may
// run while the module is still initialising.
const TIMELINE_KEY = "Timeline::Timeline"

const ALL_TIMELINE_METRICS = TIMELINE_GROUPS.flatMap(g => g.metrics)
// Set for O(1) membership checks — this gets tested per field row in the browser tree
// (potentially hundreds of rows), not just for the one field a user has already added.
const TIMELINE_METRICS_SET = new Set(ALL_TIMELINE_METRICS)

// ── Form templates ─────────────────────────────────────────────────────────────
// A Forms report is always about ONE template: its questions are the fields, so the template is
// picked with the source and behaves as one — each template is its own source module, holding the
// submission details and that template's questions. Question kinds mirror the form builder's.

type FormQuestionKind =
  | "shortText" | "longText" | "email" | "phone" | "statement"
  | "radio" | "dropdown" | "checkbox" | "multiDropdown"
  | "singleGrid" | "multiGrid"
  | "number" | "currency" | "rating" | "percent" | "date"
  | "user" | "multiUser" | "attachment"

interface FormQuestion {
  text: string
  kind: FormQuestionKind
  options?: string[]
  /** Grid questions only: each row is answered on its own. */
  gridRows?: string[]
}

interface FormTemplate { name: string; questions: FormQuestion[] }

const FORM_TEMPLATES: FormTemplate[] = [
  {
    name: "Kickoff Questionnaire",
    questions: [
      { text: "Welcome — this takes about five minutes", kind: "statement" },
      { text: "Primary goal", kind: "radio", options: ["Faster onboarding", "Lower delivery cost", "Better visibility", "Compliance"] },
      { text: "Modules in scope", kind: "checkbox", options: ["Projects", "Time tracking", "Resourcing", "Financials", "Customer portal"] },
      { text: "Integrations needed", kind: "multiDropdown", options: ["Salesforce", "HubSpot", "Jira", "Slack", "NetSuite"] },
      { text: "Team size", kind: "number" },
      { text: "Target go-live", kind: "date" },
      { text: "Executive sponsor", kind: "user" },
      { text: "Stakeholders", kind: "multiUser" },
      { text: "Additional context", kind: "longText" },
    ],
  },
  {
    name: "Client Feedback Form",
    questions: [
      { text: "Overall satisfaction", kind: "rating" },
      { text: "Would recommend", kind: "radio", options: ["Yes", "Maybe", "No"] },
      { text: "What went well", kind: "checkbox", options: ["Communication", "Timeliness", "Quality", "Expertise", "Responsiveness"] },
      { text: "Rate each area", kind: "singleGrid", gridRows: ["Communication", "Delivery", "Support"], options: ["Poor", "Fair", "Good", "Excellent"] },
      { text: "Comments", kind: "longText" },
      { text: "Contact email", kind: "email" },
    ],
  },
  {
    name: "Change Request",
    questions: [
      { text: "Change type", kind: "dropdown", options: ["Scope", "Timeline", "Budget", "Resourcing"] },
      { text: "Priority", kind: "dropdown", options: ["Low", "Medium", "High", "Urgent"] },
      { text: "Impacted areas", kind: "multiDropdown", options: ["Design", "Build", "Testing", "Training", "Go-live"] },
      { text: "Estimated cost", kind: "currency" },
      { text: "Extra hours", kind: "number" },
      { text: "Needed by", kind: "date" },
      { text: "Requested by", kind: "user" },
      { text: "Supporting documents", kind: "attachment" },
    ],
  },
  {
    name: "Risk Assessment",
    questions: [
      { text: "Risk level", kind: "radio", options: ["Low", "Medium", "High", "Critical"] },
      { text: "Risk areas by phase", kind: "multiGrid", gridRows: ["Planning", "Execution", "Go-live"], options: ["Scope", "Budget", "Resourcing", "Technical"] },
      { text: "Likelihood", kind: "percent" },
      { text: "Mitigation owners", kind: "multiUser" },
      { text: "Mitigation plan", kind: "longText" },
      { text: "Review date", kind: "date" },
      { text: "Evidence", kind: "attachment" },
    ],
  },
]
const FORM_TEMPLATE_NAMES = new Set(FORM_TEMPLATES.map((t) => t.name))
const isFormTemplateSource = (source: string) => FORM_TEMPLATE_NAMES.has(source)
/** What the source picker shows: a template reads as "Forms · <template>". */
const sourceLabel = (source: string) => (isFormTemplateSource(source) ? `Forms · ${source}` : source)

// A question becomes one field, except: a statement holds no answer (none); a grid is answered row
// by row (one field per row, named "[row] question"); an attachment reports as a file count and a
// yes/no. A single choice grid row takes one pick, so it is an ordinary single-choice field.
interface FormAnswerField extends Field { question: FormQuestion; gridRow?: string; part?: "count" | "has" }
function formQuestionFields(q: FormQuestion): FormAnswerField[] {
  switch (q.kind) {
    case "statement": return []
    case "singleGrid":
    case "multiGrid":
      return (q.gridRows ?? []).map((r) => ({ name: `[${r}] ${q.text}`, type: "text", multi: q.kind === "multiGrid", question: q, gridRow: r }))
    case "attachment":
      return [
        { name: `${q.text}: File count`, type: "number", question: q, part: "count" },
        { name: `${q.text}: Has attachment`, type: "boolean", question: q, part: "has" },
      ]
    case "checkbox": case "multiDropdown": return [{ name: q.text, type: "text", multi: true, question: q }]
    case "multiUser": return [{ name: q.text, type: "person", multi: true, question: q }]
    case "user": return [{ name: q.text, type: "person", question: q }]
    case "number": case "rating": return [{ name: q.text, type: "number", question: q }]
    case "currency": return [{ name: q.text, type: "money", question: q }]
    case "percent": return [{ name: q.text, type: "percent", question: q }]
    case "date": return [{ name: q.text, type: "date", question: q }]
    default: return [{ name: q.text, type: "text", question: q }]
  }
}

// The submission's own details, ahead of the questions in every template.
const FORM_SUBMISSION_FIELDS: Field[] = [
  { name: "Submission Date", type: "date" },
  { name: "Submitted By", type: "person" },
  { name: "Template Version", type: "text" },
]

// Every answer field, by its "Template::Field" key — so blanks read "(No answer)", choices keep the
// form's own option order, and Count means "answered".
const FORM_ANSWER_FIELDS = new Map<string, FormAnswerField>()
FORM_TEMPLATES.forEach((t) => t.questions.flatMap(formQuestionFields)
  .forEach((f) => FORM_ANSWER_FIELDS.set(`${t.name}::${f.name}`, f)))

// ── Field catalog ──────────────────────────────────────────────────────────────

const MODULES: Module[] = [
  // ── Source-capable modules ──────────────────────────────────────────────────
  {
    name: "Account",
    iconType: "account",
    canBeSource: true,
    fields: [
      { name: "Company Name", type: "text" },
      { name: "Account Owner", type: "person" },
      { name: "ARR", type: "money" },
      { name: "Account Stage", type: "text" },
      { name: "Account Health", type: "text" },
      { name: "Last Activity Date", type: "date" },
      { name: "Company Type", type: "text" },
      { name: "Capacity", type: "hours" },
      { name: "Capacity Minutes", type: "hours" },
      { name: "Is Active", type: "boolean" },
      { name: "Is Strategic", type: "boolean" },
      { name: "Contract Renewal Date", type: "date" },
    ],
  },
  {
    name: "Budget",
    iconType: "metrics",
    canBeSource: true,
    fields: [
      { name: "Budget Name", type: "text" },
      { name: "Project Budget", type: "money" },
      { name: "Budget Tracked Minutes", type: "hours" },
      { name: "Budget Remaining Minutes", type: "hours" },
      { name: "Estimate At Completion", type: "money" },
      { name: "Revenue Recognition Type", type: "text" },
      { name: "Budgeted Hours", type: "hours" },
      { name: "Billing Method", type: "text" },
      { name: "Is Default", type: "boolean" },
      { name: "Budget End Date", type: "date" },
      { name: "Budget Start Date", type: "date" },
      { name: "Budget Actual Cost", type: "money" },
      { name: "Budget Actual Revenue", type: "money" },
      { name: "Budget Estimated Cost", type: "money" },
      { name: "Budget Estimated Revenue", type: "money" },
      { name: "Status", type: "text" },
      { name: "Budget Actual Time Cost", type: "money" },
      { name: "Budget Estimated Time Cost", type: "money" },
      { name: "Budget Actual Expense Cost", type: "money" },
      { name: "Budget Estimated Expense Cost", type: "money" },
      { name: "Subscription Frequency", type: "text" },
      { name: "Number of Periods", type: "number" },
      { name: "Subscription Start Date", type: "date" },
      { name: "Current Period Number", type: "number" },
      { name: "Period Start Date", type: "date" },
      { name: "Period End Date", type: "date" },
      { name: "Period Revenue", type: "money" },
      { name: "Period Budget", type: "money" },
      { name: "Budget Current Period Total Time Tracked", type: "hours" },
      { name: "Created At", type: "date" },
      { name: "Updated At", type: "date" },
    ],
  },
  {
    name: "Forms",
    iconType: "misc",
    canBeSource: true,
    fields: [
      { name: "Template Name", type: "text" },
      { name: "Submission Date", type: "date" },
      { name: "Submitted By", type: "person" },
      { name: "Template Version Id", type: "text" },
      { name: "Answer Id", type: "number" },
      { name: "Updated By", type: "person" },
      { name: "Updated At", type: "date" },
    ],
  },
  {
    name: "People",
    iconType: "people",
    canBeSource: true,
    fields: [
      { name: "Team member name", type: "person" },
      { name: "Cost rate", type: "money" },
      { name: "Team member type", type: "text" },
      { name: "Team member status", type: "text" },
      { name: "Timesheet approver", type: "person" },
      { name: "Role", type: "text" },
      { name: "Utilisation", type: "percent" },
      { name: "Total Capacity", type: "hours" },
      { name: "Available Capacity", type: "hours" },
      { name: "Billable Utilisation", type: "percent" },
      { name: "Effective Capacity", type: "hours" },
      { name: "Planned Utilisation", type: "percent" },
      { name: "Base Capacity", type: "hours" },
    ],
  },
  {
    name: "Project",
    iconType: "project",
    canBeSource: true,
    fields: [
      { name: "Project Name", type: "text" },
      { name: "Customer", type: "text" },
      { name: "ARR", type: "money" },
      { name: "Billing type", type: "text" },
      { name: "Project Owner", type: "person" },
      { name: "Created By", type: "person" },
      { name: "Budget consumed %", type: "percent" },
      { name: "Estimate to completion (ETC)", type: "money" },
      { name: "Estimate at completion (EAC)", type: "money" },
      { name: "Status", type: "text" },
      { name: "Project currency", type: "text" },
      { name: "Due Date", type: "date" },
      { name: "Start Date", type: "date" },
      { name: "Project Fee", type: "money" },
      { name: "Available Capacity", type: "hours" },
      { name: "Project Budget", type: "money" },
      { name: "Billable Utilisation", type: "percent" },
      { name: "Progress Percent", type: "percent" },
      { name: "Project Cost", type: "money" },
      { name: "Project Profit", type: "money" },
      { name: "Project Revenue", type: "money" },
      { name: "Started on", type: "date" },
      { name: "Actual Completed Date", type: "date" },
      { name: "Inferred Progress", type: "text" },
      { name: "Last Project Update", type: "date" },
      { name: "Project age", type: "number" },
      { name: "Overall Rating", type: "number" },
      { name: "Last Milestone Rating", type: "number" },
      { name: "Budgeted Hours", type: "hours" },
      { name: "Budgeted hours consumed %", type: "percent" },
      { name: "Remaining Hours", type: "hours" },
      { name: "Estimated Cost", type: "money" },
      { name: "Project Margin", type: "percent" },
      { name: "Actual Time Cost", type: "money" },
      { name: "Estimated Time Cost", type: "money" },
      { name: "Actual Expense Cost", type: "money" },
      { name: "Estimated Expense Cost", type: "money" },
      { name: "Project Template", type: "text" },
      { name: "Partners", type: "text", multi: true },
      { name: "Current Phases", type: "text", multi: true },
      { name: "Total Recognised Revenue", type: "money" },
      { name: "Customer Members Invited", type: "number" },
      { name: "Customer Member Accepted", type: "number" },
      { name: "Last Allocation Date", type: "date" },
      { name: "Created Date", type: "date" },
      { name: "Updated At", type: "date" },
    ],
  },
  {
    name: "Role",
    iconType: "people",
    canBeSource: true,
    fields: [
      { name: "Role name", type: "text" },
      { name: "Role Type", type: "text" },
      { name: "Cost rate", type: "money" },
      { name: "Used By Partners", type: "boolean" },
      { name: "Available Capacity", type: "hours" },
      { name: "Utilisation", type: "percent" },
      { name: "Billable Utilisation", type: "percent" },
      { name: "Total Capacity", type: "hours" },
      { name: "Planned Utilisation", type: "percent" },
    ],
  },
  {
    name: "Task",
    iconType: "task",
    canBeSource: true,
    fields: [
      { name: "Task name", type: "text" },
      { name: "Project phase", type: "text" },
      { name: "Effort", type: "hours" },
      { name: "Status", type: "text" },
      { name: "Risk", type: "boolean" },
      { name: "Billable", type: "boolean" },
      { name: "Progress", type: "percent" },
      { name: "Priority", type: "text" },
      { name: "Completed at", type: "date" },
      { name: "RevRec Amount", type: "money" },
      { name: "RevRec Task", type: "boolean" },
      { name: "Due date", type: "date" },
      { name: "Start date", type: "date" },
      { name: "Completed Task", type: "number" },
      { name: "Remaining Hours", type: "hours" },
      { name: "Assignees", type: "person" },
      { name: "CSAT rating", type: "number" },
      { name: "Type", type: "text" },
      { name: "Task Description", type: "text" },
      { name: "Created by", type: "person" },
      { name: "Created on", type: "date" },
    ],
  },
  {
    name: "Time tracking",
    iconType: "time",
    canBeSource: true,
    fields: [
      { name: "Activity Name", type: "text" },
      { name: "Team member", type: "person" },
      { name: "Tracked Hours", type: "hours" },
      { name: "Billable Hours", type: "hours" },
      { name: "Billable", type: "boolean" },
      { name: "Category", type: "number" },
      { name: "Non Billable Hours", type: "hours" },
      { name: "Approved Status", type: "text" },
      { name: "Entry Type", type: "text" },
      { name: "Created date", type: "date" },
      { name: "Actual Cost", type: "money" },
      { name: "Invoiced", type: "boolean" },
      { name: "Approved Hours", type: "hours" },
      { name: "Bill rate", type: "money" },
      { name: "Cost rate", type: "money" },
      { name: "Unapproved Hours", type: "hours" },
      { name: "Actual Revenue", type: "money" },
      { name: "Status", type: "text" },
      { name: "Actual Margin", type: "money" },
      { name: "Actual Profit", type: "money" },
      { name: "Rejected Hours", type: "hours" },
      { name: "Notes", type: "text" },
      { name: "Submitted By", type: "person" },
      { name: "Submitted On", type: "date" },
      { name: "Approved By", type: "person" },
      { name: "Approved On", type: "date" },
      { name: "Rejected By", type: "person" },
      { name: "Rejected On", type: "date" },
      { name: "Created By", type: "person" },
      { name: "Created At", type: "date" },
      { name: "Updated At", type: "date" },
    ],
  },

  // ── Joined-only modules ──────────────────────────────────────────────────────
  {
    name: "Actual financials",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Actual Revenue", type: "money" },
      { name: "Actual Cost", type: "money" },
      { name: "Actual Margin", type: "money" },
      { name: "Actual Profit", type: "money" },
      { name: "Actual Expense Cost", type: "money" },
      { name: "Actual Time Cost", type: "money" },
      { name: "Bill Rate", type: "money" },
      { name: "Billable Hours", type: "hours" },
      { name: "Tracked Hours", type: "hours" },
      { name: "Non-Billable Hours", type: "hours" },
      { name: "Cost Rate", type: "money" },
    ],
  },
  {
    name: "Allocations",
    iconType: "metrics",
    canBeSource: true,
    fields: [
      { name: "Allocated Mins Raw", type: "hours" },
      { name: "Allocation Type", type: "text" },
      { name: "Is Billable", type: "boolean" },
      { name: "Allocated Hours", type: "hours" },
      { name: "Hard Allocated Hours", type: "hours" },
      { name: "Soft Allocated Hours", type: "hours" },
      { name: "Work Type", type: "text" },
      { name: "Allocated Seconds", type: "hours" },
      { name: "Start Date", type: "date" },
      { name: "End Date", type: "date" },
      { name: "Allocation Medium", type: "text" },
    ],
  },
  {
    name: "Assignee effort",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Effort", type: "hours" },
      { name: "Created By", type: "person" },
      { name: "Created At", type: "date" },
      { name: "Updated By", type: "person" },
      { name: "Updated At", type: "date" },
    ],
  },
  {
    name: "Backlog",
    iconType: "task",
    canBeSource: false,
    fields: [
      { name: "Backlog Name", type: "text" },
      { name: "Backlog Owner", type: "person" },
    ],
  },
  {
    name: "Capacity",
    iconType: "time",
    canBeSource: false,
    fields: [
      { name: "User status", type: "text" },
      { name: "Capacity", type: "hours" },
      { name: "Date", type: "date" },
    ],
  },
  {
    name: "Credit notes",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Credit Note Number", type: "text" },
      { name: "Currency", type: "text" },
      { name: "Invoice Number", type: "text" },
      { name: "Status", type: "text" },
      { name: "Amount", type: "money" },
      { name: "Project Financials Budgets", type: "money" },
      { name: "Sub Total", type: "money" },
      { name: "Tax", type: "money" },
    ],
  },
  {
    name: "Daily rollup",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Billable Utilisation", type: "percent" },
      { name: "Capacity In Minutes", type: "hours" },
      { name: "Utilisation", type: "percent" },
      { name: "Actual Cost", type: "money" },
      { name: "Actual Margin", type: "money" },
      { name: "Actual Revenue", type: "money" },
      { name: "Actual profit", type: "money" },
      { name: "Allocated Hours", type: "hours" },
      { name: "Bill rate", type: "money" },
      { name: "Cost rate", type: "money" },
      { name: "Estimated Margin", type: "money" },
      { name: "Estimated Profit", type: "money" },
      { name: "Estimated Revenue", type: "money" },
      { name: "Estimated cost", type: "money" },
      { name: "Hard Allocated Hours", type: "hours" },
      { name: "Planned Utilisation", type: "percent" },
      { name: "Soft Allocated Hours", type: "hours" },
      { name: "Tracked Hours", type: "hours" },
      { name: "Billable Hours", type: "hours" },
      { name: "Non Billable Hours", type: "hours" },
    ],
  },
  {
    name: "Epic",
    iconType: "task",
    canBeSource: false,
    fields: [
      { name: "Epic Name", type: "text" },
      { name: "Epic Owner", type: "person" },
      { name: "Epic Squad", type: "person" },
      { name: "Epic Status", type: "text" },
      { name: "Priority Str", type: "text" },
      { name: "Effort", type: "hours" },
      { name: "Task Progress", type: "percent" },
      { name: "Tracked Hours", type: "hours" },
    ],
  },
  {
    name: "Estimated financials",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Estimated Revenue", type: "money" },
      { name: "Estimated Cost", type: "money" },
      { name: "Allocated Hours", type: "hours" },
      { name: "Estimated Margin", type: "money" },
      { name: "Estimated Profit", type: "money" },
      { name: "Hard Allocated Hours", type: "hours" },
      { name: "Soft Allocated Hours", type: "hours" },
      { name: "Bill Rate", type: "money" },
      { name: "Billable Allocated Hours", type: "hours" },
      { name: "Non Billable Allocated Hours", type: "hours" },
      { name: "Estimated Time Cost", type: "money" },
      { name: "Estimated Expense Cost", type: "money" },
      { name: "Cost Rate", type: "money" },
    ],
  },
  {
    name: "Expense",
    iconType: "metrics",
    canBeSource: true,
    fields: [
      { name: "Amount", type: "money" },
      { name: "Expense owner", type: "person" },
      { name: "Billable Amount", type: "money" },
      { name: "Currency", type: "text" },
      { name: "Expense Status", type: "text" },
      { name: "Reimburse To Source Type", type: "text" },
      { name: "Non Billable Amount", type: "money" },
      { name: "Non Reimbursable Amount", type: "money" },
      { name: "Reimbursable Amount", type: "money" },
    ],
  },
  {
    name: "Expense budget",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Expense Budget", type: "text" },
      { name: "Currency", type: "text" },
      { name: "Amount", type: "money" },
      { name: "Billable", type: "boolean" },
      { name: "Enabled", type: "boolean" },
    ],
  },
  {
    name: "Expense report",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Expense Report", type: "text" },
      { name: "Currency", type: "text" },
      { name: "Expense Report Status", type: "text" },
      { name: "Total Amount", type: "money" },
    ],
  },
  {
    name: "Invoice",
    iconType: "metrics",
    canBeSource: true,
    fields: [
      { name: "Invoice Number", type: "text" },
      { name: "Amount", type: "money" },
      { name: "Amount Outstanding", type: "money" },
      { name: "Invoice Status", type: "text" },
      { name: "Date Of Issue", type: "date" },
      { name: "Payment Status", type: "text" },
      { name: "Paid Amount", type: "money" },
      { name: "Currency", type: "text" },
    ],
  },
  {
    name: "Leave & holiday",
    iconType: "time",
    canBeSource: false,
    fields: [
      { name: "Total Leave", type: "hours" },
      { name: "Holiday", type: "hours" },
      { name: "Timeoff", type: "hours" },
      { name: "Source Type", type: "text" },
      { name: "Duration", type: "hours" },
      { name: "Date", type: "date" },
    ],
  },
  {
    name: "Meeting",
    iconType: "misc",
    canBeSource: false,
    fields: [
      { name: "Meeting Name", type: "text" },
      { name: "Meeting Type", type: "text" },
      { name: "Duration Seconds", type: "hours" },
      { name: "Deal Stage", type: "text" },
      { name: "Meeting Status", type: "text" },
      { name: "Pipeline Status", type: "text" },
      { name: "Source Label", type: "text" },
      { name: "Is Transcript Available", type: "boolean" },
    ],
  },
  {
    name: "Phase",
    iconType: "project",
    canBeSource: false,
    fields: [
      { name: "Project phase", type: "text" },
      { name: "Phase Status", type: "text" },
      { name: "Completed At", type: "date" },
      { name: "Due Date", type: "date" },
      { name: "Start Date", type: "date" },
      { name: "Start Date Actual", type: "date" },
      { name: "Updated by", type: "person" },
    ],
  },
  {
    name: "Policy checks",
    iconType: "misc",
    canBeSource: false,
    fields: [
      { name: "Entity Type", type: "text" },
      { name: "Policy Sub Type", type: "text" },
      { name: "Policy Type", type: "text" },
      { name: "Is Violated", type: "boolean" },
      { name: "Created At", type: "date" },
      { name: "Updated At", type: "date" },
      { name: "Execution Time Ms", type: "number" },
      { name: "Parallel Batch", type: "number" },
    ],
  },
  {
    name: "Project members",
    iconType: "project",
    canBeSource: false,
    fields: [
      { name: "Source Type", type: "text" },
      { name: "Active", type: "boolean" },
      { name: "Is Default", type: "boolean" },
      { name: "Joined At", type: "date" },
    ],
  },
  {
    name: "Project teams",
    iconType: "project",
    canBeSource: false,
    fields: [
      { name: "Joined At", type: "date" },
    ],
  },
  {
    name: "Revenue entries",
    iconType: "metrics",
    canBeSource: false,
    fields: [
      { name: "Revenue To Recognise", type: "money" },
      { name: "Amount (Account Currency)", type: "money" },
      { name: "End Date", type: "date" },
      { name: "Start Date", type: "date" },
    ],
  },
  {
    name: "Signals",
    iconType: "misc",
    canBeSource: false,
    fields: [
      { name: "Signal", type: "text" },
      { name: "Signal Type", type: "text" },
      { name: "Source Type", type: "text" },
      { name: "Reported By", type: "person" },
      { name: "Reported By Email", type: "text" },
      { name: "Reported By Emails", type: "text" },
      { name: "Summary", type: "text" },
    ],
  },
  {
    name: "Sprint",
    iconType: "task",
    canBeSource: false,
    fields: [
      { name: "Sprint Name", type: "text" },
      { name: "Sprint Owner", type: "person" },
      { name: "Sprint Squad", type: "person" },
      { name: "Sprint Status", type: "text" },
      { name: "Sprint Type", type: "text" },
      { name: "Actual Duration", type: "hours" },
      { name: "Duration", type: "hours" },
      { name: "Effort In Minutes", type: "hours" },
    ],
  },
  {
    name: "Team",
    iconType: "people",
    canBeSource: false,
    fields: [],
  },
  {
    name: "Team membership",
    iconType: "people",
    canBeSource: false,
    fields: [],
  },
  // One per form template: the submission details, then the template's questions.
  ...FORM_TEMPLATES.map((t): Module => ({
    name: t.name,
    iconType: "misc",
    canBeSource: true,
    fields: [...FORM_SUBMISSION_FIELDS, ...t.questions.flatMap(formQuestionFields).map(({ name, type, multi }) => ({ name, type, multi }))],
  })),
]

// Which modules are reachable from each source, per MODULES.md's "which modules each
// source can use" table. A module's own fields never change with the source picked —
// the source only decides which other modules can be joined alongside it.
const SOURCE_MODULES: Record<string, string[]> = {
  "Time tracking": ["Time tracking", "Project", "People", "Role", "Phase", "Task", "Budget", "Invoice", "Capacity", "Expense", "Allocations"],
  "Project": ["Project", "Phase", "Time tracking", "People", "Capacity", "Budget", "Account", "Task", "Actual financials", "Allocations", "Estimated financials", "Leave & holiday", "Expense", "Invoice", "Project members", "Daily rollup", "Assignee effort"],
  "Task": ["Task", "Project", "Time tracking", "Budget", "Role", "People", "Account", "Allocations", "Epic", "Sprint", "Assignee effort"],
  "Budget": ["Budget", "Project", "Invoice", "Phase", "Time tracking", "Account", "Actual financials", "Expense", "Revenue entries", "Estimated financials", "Forms", "Task"],
  "People": ["People", "Role", "Time tracking", "Capacity", "Project", "Leave & holiday", "Actual financials", "Allocations", "Account", "Estimated financials", "Daily rollup"],
  "Role": ["Role", "People", "Time tracking", "Capacity", "Allocations", "Actual financials", "Leave & holiday", "Project", "Estimated financials", "Daily rollup", "Task"],
  "Account": ["Account", "Project", "Actual financials", "Time tracking", "Invoice", "Revenue entries", "Budget", "Meeting", "Daily rollup", "Task"],
  "Forms": ["Forms", "Project", "Account", "Task", "Phase", "People"],
  // Each allocation, expense and invoice row points at exactly one of these, so they are all
  // lookups and the records stay one per allocation, expense or invoice.
  "Allocations": ["Allocations", "Project", "People", "Role", "Task", "Phase", "Budget", "Account"],
  "Expense": ["Expense", "Project", "People", "Role", "Task", "Phase", "Budget", "Invoice", "Account"],
  // Time tracking and Expense are billed on an invoice, so they fan out from it.
  "Invoice": ["Invoice", "Account", "Project", "Budget", "Time tracking", "Expense", "Revenue entries"],
  // A Forms report runs on one template. Each submission belongs to a task (and so its phase,
  // project and account), and People is reached through who submitted it.
  ...Object.fromEntries(FORM_TEMPLATES.map((t) => [t.name, [t.name, "Project", "Account", "Task", "Phase", "People"]])),
}

// "Forms" opens the template list rather than being a source of its own.
const SOURCE_OPTIONS = ["Time tracking", "Project", "Task", "Budget", "People", "Role", "Account", "Allocations", "Expense", "Invoice", "Forms"]

const AGG_OPTIONS = ["Sum", "Count", "Distinct Count", "Average", "Min", "Max"]

// ── The viewer ────────────────────────────────────────────────────────────────
// A "current user" filter stores the RULE, not a name, so the same saved report shows each
// person their own rows. Standing in for the session's signed-in user; the switcher in the nav
// exists so the behaviour can actually be demonstrated with one browser.
const CURRENT_USER_KEY = "customReportsV2.currentUser"
let CURRENT_USER_NAME: string | null = null
function getCurrentUserName(): string {
  // Read on first use rather than at module load: PERSON_NAMES is defined further down.
  if (CURRENT_USER_NAME === null) {
    // Default to the owner of the first project rather than the first name on the list: the
    // first name owns nothing in the sample data, so a "my projects" report would open empty
    // and read as broken.
    const fallback = String(PEOPLE_BY_ID[PROJECTS[0]?.ownerId]?.["Team member name"] ?? PERSON_NAMES[0])
    try { CURRENT_USER_NAME = localStorage.getItem(CURRENT_USER_KEY) || fallback }
    catch { CURRENT_USER_NAME = fallback }
  }
  return CURRENT_USER_NAME
}
function setCurrentUserName(name: string): void {
  CURRENT_USER_NAME = name
  try { localStorage.setItem(CURRENT_USER_KEY, name) } catch {}
}

// ── Mock field values (for filter picker) ─────────────────────────────────────

// Real distinct values pulled straight from the generated dataset (defined further down,
// but this function isn't called until render time, long after module init completes).
function fieldValues(key: string, type: FieldType): string[] | null {
  if (type === "boolean") return ["Yes", "No"]
  if (type !== "text" && type !== "person") return null
  const mod = fieldKeyModule(key)
  const field = fieldDisplayName(key)
  const rows = MODULE_ROWS[mod]
  if (!rows || rows.length === 0) return null
  const values = new Set<string>()
  rows.forEach((row) => {
    const raw = row[field]
    ;(Array.isArray(raw) ? raw : [raw]).forEach((v) => { if (v != null && v !== "") values.add(String(v)) })
  })
  return values.size > 0 ? [...values].sort((a, b) => a.localeCompare(b)) : null
}

// Straight from the raw dataset, ignoring grain/filters — just enough to show the field's
// rough span in the RangeConfigPicker (the real bucketing bounds, used at render time, are
// computed from the actually-filtered rows in buildLabeler).
function numericFieldBounds(key: string): { min: number; max: number } {
  const mod = fieldKeyModule(key)
  const field = fieldDisplayName(key)
  const rows = MODULE_ROWS[mod] ?? []
  const nums = rows.map((r) => Number(r[field])).filter((n) => !Number.isNaN(n))
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: 0, max: 1 }
}

// ── Icons ──────────────────────────────────────────────────────────────────────

const Ic = {
  Search: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  ),
  Bell: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  Home: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  Folder: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Grid: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  BarChart: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  List: ({ size = 18 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  Users: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Apps: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><circle cx="8" cy="16" r="3" /><circle cx="16" cy="16" r="3" />
    </svg>
  ),
  Sparkle: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  ),
  Gift: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12" /><rect x="2" y="7" width="20" height="5" /><line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  ),
  Message: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Globe: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  Filter: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  Calendar: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  Hash: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  ),
  LineChart: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  Highlighter: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  ),
  ChevDown: ({ size = 12 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  ChevRight: ({ size = 12 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  X: ({ size = 12 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  Person: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
  Text: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  Sidebar: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  ),
  ViewDetail: ({ size = 15 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="9" y1="10" x2="9" y2="20" /><line x1="15" y1="10" x2="15" y2="20" />
    </svg>
  ),
  ViewCompact: ({ size = 15 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="20" y2="12" /><line x1="10" y1="18" x2="20" y2="18" />
    </svg>
  ),
  Sigma: ({ size = 15 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 5H6l7 7-7 7h12" />
    </svg>
  ),
  Gear: ({ size = 15 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  AlignLeft: ({ size = 13 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="18" y2="18" />
    </svg>
  ),
  AlignCenter: ({ size = 13 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="6" y1="12" x2="18" y2="12" /><line x1="4.5" y1="18" x2="19.5" y2="18" />
    </svg>
  ),
  AlignRight: ({ size = 13 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="9" y1="12" x2="21" y2="12" /><line x1="6" y1="18" x2="21" y2="18" />
    </svg>
  ),
  Project: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="2" />
    </svg>
  ),
  Clock: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  Building: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" /><line x1="9" y1="7" x2="9" y2="7.01" /><line x1="15" y1="7" x2="15" y2="7.01" />
      <line x1="9" y1="12" x2="9" y2="12.01" /><line x1="15" y1="12" x2="15" y2="12.01" />
      <path d="M9 17h6" />
    </svg>
  ),
  GripVertical: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="6" r="1" fill="currentColor" /><circle cx="15" cy="6" r="1" fill="currentColor" />
      <circle cx="9" cy="12" r="1" fill="currentColor" /><circle cx="15" cy="12" r="1" fill="currentColor" />
      <circle cx="9" cy="18" r="1" fill="currentColor" /><circle cx="15" cy="18" r="1" fill="currentColor" />
    </svg>
  ),
  DotsV: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
    </svg>
  ),
  ExpandAll: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7 13 12 18 17 13" /><polyline points="7 6 12 11 17 6" />
    </svg>
  ),
  Eye: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Pencil: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  Download: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  Printer: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  ),
  Save: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
    </svg>
  ),
  SortIcon: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="9" y2="18" />
    </svg>
  ),
  Sliders: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  ),
  Check: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  Sheet: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="9" x2="9" y2="21" />
    </svg>
  ),
  Trash: ({ size = 13 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Money/hours/percent all behave like plain numbers for aggregation, coloring, and dimension purposes.
function isNumericType(type: FieldType): boolean {
  return type === "number" || type === "money" || type === "hours" || type === "percent"
}

function fieldTypeColor(type: FieldType) {
  return isNumericType(type) ? "text-emerald-500" : "text-violet-500"
}

function fieldTypeIcon(type: FieldType, size = 13) {
  const cls = fieldTypeColor(type)
  if (isNumericType(type)) return <span className={cls}><Ic.Hash size={size} /></span>
  if (type === "date")   return <span className={cls}><Ic.Calendar size={size} /></span>
  if (type === "person") return <span className={cls}><Ic.Person size={size} /></span>
  if (type === "boolean") return <span className={cls}><Ic.Check /></span>
  return <span className={cls}><Ic.Text size={size} /></span>
}

function moduleIcon(iconType: Module["iconType"], size = 14) {
  if (iconType === "project") return <Ic.Project size={size} />
  if (iconType === "time") return <Ic.Clock size={size} />
  if (iconType === "metrics") return <Ic.LineChart size={size} />
  if (iconType === "task") return <Ic.List size={size} />
  if (iconType === "people") return <Ic.Users />
  if (iconType === "misc") return <Ic.Apps />
  return <Ic.Building size={size} />
}

function allAddedFields(fields: PivotFields): Set<string> {
  return new Set([...fields.columns, ...fields.rows, ...fields.values].map((item) => item.field))
}

// The real schema has genuine duplicate field names across different modules (e.g. "Status"
// exists on both Task and Time tracking, "Currency" on five different modules). A bare field
// name can't be a unique identity, so every field is addressed everywhere in the app by a
// composite key of "Module::Field Name" — only the trailing name is ever shown to the user.
function makeFieldKey(moduleName: string, fieldName: string): string {
  return `${moduleName}::${fieldName}`
}

function fieldKeyModule(key: string): string {
  return key.slice(0, key.indexOf("::"))
}

function fieldDisplayName(key: string): string {
  if (isFormulaKey(key)) return formulaOf(key)?.name ?? "Deleted formula"
  const i = key.indexOf("::")
  return i === -1 ? key : key.slice(i + 2)
}

function getFieldType(key: string): FieldType {
  if (key === TIMELINE_KEY) return "date"
  if (isFormulaKey(key)) return "number"
  const mod = MODULES.find((m) => m.name === fieldKeyModule(key))
  const field = mod?.fields.find((f) => f.name === fieldDisplayName(key))
  return field?.type ?? "text"
}

// ── Formula fields (today's feature, carried over unchanged) ─────────────────────
// A formula is saved for the account against a source, like today: every report on that source
// lists it. It references up to 26 number or date fields as the letters A–Z and holds one
// expression over them. In a pivot it is worked out per cell from its fields' totals, and totals
// are the formula over the totalled fields (sum(A)/sum(B)). In a table it is worked out per record.
const FORMULA_PREFIX = "Formula::"
interface FormulaRef { letter: string; field: string }
interface FormulaDef {
  id: string
  name: string
  source: string
  refs: FormulaRef[]
  expression: string
  excludeWeekends: boolean
}
// Final V2 field names (2026-11-26): a field that exists in today's Custom Reports keeps its V1
// name exactly; new fields use V2's names. Keys are the previous "Module::Field" names.
const FIELD_RENAMES: Record<string, string> = {
 "Account::Company name": "Company Name",
 "Account::Company type": "Company Type",
 "Account::Is active": "Is Active",
 "Account::Is strategic": "Is Strategic",
 "Budget::Budget name": "Budget Name",
 "Budget::Is default": "Is Default",
 "Budget::Subscription frequency": "Subscription Frequency",
 "Budget::Current period revenue": "Period Revenue",
 "Budget::Current period budget": "Period Budget",
 "Budget::Created at": "Created At",
 "Budget::Last updated at": "Updated At",
 "Forms::Last edited by": "Updated By",
 "Forms::Last edited at": "Updated At",
 "People::Total capacity": "Total Capacity",
 "People::Available capacity": "Available Capacity",
 "People::Billable utilisation": "Billable Utilisation",
 "People::Effective capacity": "Effective Capacity",
 "People::Planned utilisation": "Planned Utilisation",
 "Project::Project owner": "Project Owner",
 "Project::Created by": "Created By",
 "Project::Available capacity": "Available Capacity",
 "Project::Billable utilisation": "Billable Utilisation",
 "Project::Actual start date": "Started on",
 "Project::Inferred progress": "Inferred Progress",
 "Project::Budgeted hours": "Budgeted Hours",
 "Project::Remaining hours": "Remaining Hours",
 "Project::Estimated cost": "Estimated Cost",
 "Project::Actual time cost": "Actual Time Cost",
 "Project::Estimated time cost": "Estimated Time Cost",
 "Project::Actual expense cost": "Actual Expense Cost",
 "Project::Estimated expense cost": "Estimated Expense Cost",
 "Project::Current phases": "Current Phases",
 "Project::Total recognised revenue": "Total Recognised Revenue",
 "Project::Customer members invited": "Customer Members Invited",
 "Project::Customer members accepted": "Customer Member Accepted",
 "Project::Last allocation date": "Last Allocation Date",
 "Project::Created at": "Created Date",
 "Project::Last updated at": "Updated At",
 "Role::Available capacity": "Available Capacity",
 "Role::Billable utilisation": "Billable Utilisation",
 "Role::Total capacity": "Total Capacity",
 "Role::Planned utilisation": "Planned Utilisation",
 "Task::Completed tasks": "Completed Task",
 "Task::Remaining hours": "Remaining Hours",
 "Task::Description": "Task Description",
 "Task::Created at": "Created on",
 "Time tracking::Submitted by": "Submitted By",
 "Time tracking::Submitted on": "Submitted On",
 "Time tracking::Approved by": "Approved By",
 "Time tracking::Approved on": "Approved On",
 "Time tracking::Rejected by": "Rejected By",
 "Time tracking::Rejected on": "Rejected On",
 "Time tracking::Created by": "Created By",
 "Time tracking::Created at": "Created At",
 "Time tracking::Last updated at": "Updated At",
 "Actual financials::Tracked hours": "Tracked Hours",
 "Actual financials::Non-billable hours": "Non-Billable Hours",
 "Actual financials::Cost rate": "Cost Rate",
 "Allocations::Allocated hours": "Allocated Hours",
 "Allocations::Hard allocated hours": "Hard Allocated Hours",
 "Allocations::Soft allocated hours": "Soft Allocated Hours",
 "Allocations::Start date": "Start Date",
 "Allocations::End date": "End Date",
 "Allocations::Allocation medium": "Allocation Medium",
 "Assignee effort::Assignee effort": "Effort",
 "Assignee effort::Created by": "Created By",
 "Assignee effort::Created at": "Created At",
 "Assignee effort::Last updated by": "Updated By",
 "Assignee effort::Last updated at": "Updated At",
 "Backlog::Backlog name": "Backlog Name",
 "Backlog::Backlog owner": "Backlog Owner",
 "Capacity::Team member status": "User status",
 "Credit notes::Credit note number": "Credit Note Number",
 "Credit notes::Invoice number": "Invoice Number",
 "Credit notes::Project financials budgets": "Project Financials Budgets",
 "Credit notes::Sub total": "Sub Total",
 "Daily rollup::Capacity in minutes": "Capacity In Minutes",
 "Daily rollup::Planned utilisation": "Planned Utilisation",
 "Daily rollup::Soft allocated hours": "Soft Allocated Hours",
 "Daily rollup::Tracked hours": "Tracked Hours",
 "Daily rollup::Billable hours": "Billable Hours",
 "Daily rollup::Non-billable hours": "Non Billable Hours",
 "Epic::Epic name": "Epic Name",
 "Epic::Epic owner": "Epic Owner",
 "Epic::Epic squad": "Epic Squad",
 "Epic::Epic status": "Epic Status",
 "Epic::Priority str": "Priority Str",
 "Epic::Task progress": "Task Progress",
 "Epic::Tracked hours": "Tracked Hours",
 "Estimated financials::Billable allocated hours": "Billable Allocated Hours",
 "Estimated financials::Non-billable allocated hours": "Non Billable Allocated Hours",
 "Estimated financials::Estimated time cost": "Estimated Time Cost",
 "Estimated financials::Estimated expense cost": "Estimated Expense Cost",
 "Estimated financials::Cost rate": "Cost Rate",
 "Expense::Expense status": "Expense Status",
 "Expense budget::Expense budget": "Expense Budget",
 "Expense report::Expense report": "Expense Report",
 "Expense report::Expense report status": "Expense Report Status",
 "Invoice::Invoice number": "Invoice Number",
 "Invoice::Invoice status": "Invoice Status",
 "Invoice::Date of Issue": "Date Of Issue",
 "Invoice::Payment status": "Payment Status",
 "Leave & holiday::Total leave": "Total Leave",
 "Meeting::Meeting name": "Meeting Name",
 "Meeting::Meeting type": "Meeting Type",
 "Meeting::Duration seconds": "Duration Seconds",
 "Meeting::Deal stage": "Deal Stage",
 "Meeting::Meeting status": "Meeting Status",
 "Meeting::Pipeline status": "Pipeline Status",
 "Meeting::Source label": "Source Label",
 "Meeting::Is transcript available": "Is Transcript Available",
 "Phase::Phase status": "Phase Status",
 "Phase::Completed at": "Completed At",
 "Phase::Due date": "Due Date",
 "Phase::Start date": "Start Date",
 "Phase::Start date actual": "Start Date Actual",
 "Project members::Source type": "Source Type",
 "Project members::Is default": "Is Default",
 "Project members::Joined at": "Joined At",
 "Project teams::Joined at": "Joined At",
 "Revenue entries::Revenue to recognise": "Revenue To Recognise",
 "Signals::Signal type": "Signal Type",
 "Signals::Source type": "Source Type",
 "Signals::Reported by": "Reported By",
 "Signals::Reported by email": "Reported By Email",
 "Signals::Reported by emails": "Reported By Emails",
 "Sprint::Sprint name": "Sprint Name",
 "Sprint::Sprint owner": "Sprint Owner",
 "Sprint::Sprint squad": "Sprint Squad",
 "Sprint::Sprint status": "Sprint Status",
 "Sprint::Sprint type": "Sprint Type",
 "Sprint::Actual duration": "Actual Duration",
 "Sprint::Effort in minutes": "Effort In Minutes",
 "Account::Company owner": "Account Owner",
 "Account::Company stage": "Account Stage",
 "Account::Company health": "Account Health",
 "Account::Last activity": "Last Activity Date",
 "Budget::RevRec type": "Revenue Recognition Type",
 "Budget::Contract type": "Billing Method",
 "Budget::Actual time cost": "Budget Actual Time Cost",
 "Budget::Estimated time cost": "Budget Estimated Time Cost",
 "Budget::Actual expense cost": "Budget Actual Expense Cost",
 "Budget::Estimated expense cost": "Budget Estimated Expense Cost",
 "Budget::No. of periods": "Number of Periods",
 "Budget::Subscription start": "Subscription Start Date",
 "Budget::Current period no.": "Current Period Number",
 "Budget::Current period start": "Period Start Date",
 "Budget::Current period end": "Period End Date",
 "Budget::Current period tracked time": "Budget Current Period Total Time Tracked",
 "Project::Project status": "Status",
 "Project::Actual end date": "Actual Completed Date",
 "Project::Last status update": "Last Project Update",
 "Project::CSAT rating": "Overall Rating",
 "Project::Last milestone CSAT": "Last Milestone Rating",
 "Project::% budgeted hours consumed": "Budgeted hours consumed %",
 "Project::Actual margin": "Project Margin",
 "Project::Template": "Project Template"
}

// Older saved reports, views and formulas name fields by their previous "Module::Field" key.
function migrateFieldKeys<T>(value: T): T {
  if (typeof value === "string") {
    const next = FIELD_RENAMES[value]
    return (next ? value.slice(0, value.indexOf("::") + 2) + next : value) as unknown as T
  }
  if (Array.isArray(value)) return value.map(migrateFieldKeys) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) => { out[k] = migrateFieldKeys(v) })
    return out as T
  }
  return value
}

const FORMULAS_KEY = "customReportsV2.formulaFields"
let FORMULAS: FormulaDef[] = (() => {
  try { const raw = localStorage.getItem(FORMULAS_KEY); return raw ? migrateFieldKeys(JSON.parse(raw)) : [] } catch { return [] }
})()
const formulaListeners = new Set<() => void>()
function setFormulas(next: FormulaDef[]) {
  FORMULAS = next
  try { localStorage.setItem(FORMULAS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  formulaListeners.forEach((l) => l())
}
/** Re-renders the caller whenever a formula is created, edited or deleted. */
function useFormulas(): FormulaDef[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    formulaListeners.add(l)
    return () => { formulaListeners.delete(l) }
  }, [])
  return FORMULAS
}
function isFormulaKey(key: string): boolean { return key.startsWith(FORMULA_PREFIX) }
function formulaKeyOf(def: FormulaDef): string { return FORMULA_PREFIX + def.id }
function formulaOf(key: string): FormulaDef | undefined {
  return isFormulaKey(key) ? FORMULAS.find((f) => FORMULA_PREFIX + f.id === key) : undefined
}
const FORMULA_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")

// The expression language today's engine accepts: numbers, the letters, + − * /, comparisons,
// parentheses, and IF, ISNULL, ISNUMBER, ISBLANK, NULLVALUE, BLANKVALUE, TODAY. Date minus date
// gives days. Anything null makes the result null, and dividing by zero gives null (a blank cell).
type FVal = number | boolean | { day: number } | null
const DAY_MS = 86400000
const toDay = (v: any): { day: number } | null => {
  if (v == null || v === "") return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : { day: Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / DAY_MS) }
}
function businessDaysBetween(fromDay: number, toDay_: number): number {
  const sign = toDay_ >= fromDay ? 1 : -1
  let n = 0
  for (let d = Math.min(fromDay, toDay_); d < Math.max(fromDay, toDay_); d++) {
    const wd = new Date(d * DAY_MS).getUTCDay()
    if (wd !== 0 && wd !== 6) n++
  }
  return n * sign
}

interface FormulaAst { k: string; v?: any; a?: FormulaAst; b?: FormulaAst; args?: FormulaAst[]; op?: string }
function parseFormula(src: string): FormulaAst {
  const toks: string[] = []
  const re = /\s*(\d+\.?\d*|\.\d+|[A-Za-z_][A-Za-z_]*|<>|<=|>=|[-+*/(),<>=%])/y
  let i = 0
  const text = src.trim()
  while (i < text.length) {
    re.lastIndex = i
    const m = re.exec(text)
    if (!m) throw new Error("bad token")
    toks.push(m[1].toUpperCase())
    i = re.lastIndex
    while (i < text.length && /\s/.test(text[i])) i++
  }
  let p = 0
  const peek = () => toks[p]
  const eat = (t?: string) => { const x = toks[p]; if (t && x !== t) throw new Error(`expected ${t}`); p++; return x }
  const primary = (): FormulaAst => {
    const t = peek()
    if (t == null) throw new Error("unexpected end")
    if (t === "(") { eat("("); const e = comparison(); eat(")"); return e }
    if (t === "-") { eat(); return { k: "neg", a: primary() } }
    if (/^[\d.]/.test(t)) { eat(); return { k: "num", v: Number(t) } }
    if (/^[A-Z_]+$/.test(t)) {
      eat()
      if (peek() === "(") {
        eat("(")
        const args: FormulaAst[] = []
        if (peek() !== ")") { args.push(comparison()); while (peek() === ",") { eat(","); args.push(comparison()) } }
        eat(")")
        return { k: "fn", v: t, args }
      }
      if (t === "NULL") return { k: "null" }
      if (t.length !== 1) throw new Error("unknown name")
      return { k: "ref", v: t }
    }
    throw new Error("unexpected token")
  }
  const term = (): FormulaAst => {
    let a = primary()
    while (peek() === "*" || peek() === "/") { const op = eat(); a = { k: "bin", op, a, b: primary() } }
    return a
  }
  const additive = (): FormulaAst => {
    let a = term()
    while (peek() === "+" || peek() === "-") { const op = eat(); a = { k: "bin", op, a, b: term() } }
    return a
  }
  const comparison = (): FormulaAst => {
    const a = additive()
    const op = peek()
    if (op && ["=", "<>", "<", ">", "<=", ">="].includes(op)) { eat(); return { k: "bin", op, a, b: additive() } }
    return a
  }
  const ast = comparison()
  if (p !== toks.length) throw new Error("trailing tokens")
  return ast
}

function evalFormula(ast: FormulaAst, env: Record<string, FVal>, excludeWeekends: boolean): FVal {
  const ev = (n: FormulaAst): FVal => evalFormula(n, env, excludeWeekends)
  const isDay = (v: FVal): v is { day: number } => typeof v === "object" && v !== null
  const num = (v: FVal): number | null => v == null ? null : typeof v === "boolean" ? (v ? 1 : 0) : isDay(v) ? v.day : v
  switch (ast.k) {
    case "num": return ast.v
    case "null": return null
    case "ref": return env[ast.v] ?? null
    case "neg": { const v = num(ev(ast.a!)); return v == null ? null : -v }
    case "fn": {
      const args = ast.args ?? []
      switch (ast.v) {
        case "IF": { const c = ev(args[0]); return c ? ev(args[1]) : args[2] ? ev(args[2]) : null }
        case "ISNULL": case "ISBLANK": return ev(args[0]) == null
        case "ISNUMBER": { const v = ev(args[0]); return typeof v === "number" }
        case "NULLVALUE": case "BLANKVALUE": { const v = ev(args[0]); return v == null ? ev(args[1]) : v }
        case "TODAY": return toDay(TODAY)
        default: throw new Error("unknown function")
      }
    }
    case "bin": {
      const a = ev(ast.a!), b = ev(ast.b!)
      if (a == null || b == null) return null
      if (ast.op === "-" && isDay(a) && isDay(b)) {
        return excludeWeekends ? businessDaysBetween(b.day, a.day) : a.day - b.day
      }
      const x = num(a)!, y = num(b)!
      switch (ast.op) {
        case "+": return isDay(a) || isDay(b) ? { day: x + y } : x + y
        case "-": return isDay(a) ? { day: x - y } : x - y
        case "*": return x * y
        case "/": return y === 0 ? null : x / y
        case "=": return x === y
        case "<>": return x !== y
        case "<": return x < y
        case ">": return x > y
        case "<=": return x <= y
        case ">=": return x >= y
      }
    }
  }
  return null
}

/** Today's save-time checks. Any failure gets the same generic error the product shows. */
function formulaIsValid(expression: string, refs: FormulaRef[]): boolean {
  const expr = expression.trim()
  if (!/^[a-zA-Z0-9\s+\-*/(),<>=._%]+$/.test(expr)) return false
  if (/^[+*/<>=,]/.test(expr)) return false
  let ast: FormulaAst
  try { ast = parseFormula(expr) } catch { return false }
  const types = new Map(refs.map((r) => [r.letter, getFieldType(r.field)]))
  let ok = true
  // Returns "date" | "number" for the node, and flags what today's validator rejects:
  // an unknown letter, multiplying or dividing a date, adding two dates, a date on its own.
  const kind = (n: FormulaAst): "date" | "number" => {
    switch (n.k) {
      case "ref": {
        if (!types.has(n.v)) { ok = false; return "number" }
        return types.get(n.v) === "date" ? "date" : "number"
      }
      case "fn": {
        if (!["IF", "ISNULL", "ISBLANK", "ISNUMBER", "NULLVALUE", "BLANKVALUE", "TODAY"].includes(n.v)) ok = false
        const ks = (n.args ?? []).map(kind)
        if (n.v === "TODAY") return "date"
        if (n.v === "IF") return ks[1] ?? "number"
        if (n.v === "NULLVALUE" || n.v === "BLANKVALUE") return ks[0] ?? "number"
        return "number"
      }
      case "neg": return kind(n.a!)
      case "bin": {
        const a = kind(n.a!), b = kind(n.b!)
        if ((n.op === "*" || n.op === "/") && (a === "date" || b === "date")) ok = false
        if (n.op === "+" && a === "date" && b === "date") ok = false
        if (n.op === "-" && a === "date" && b === "date") return "number"
        return a === "date" || b === "date" ? "date" : "number"
      }
    }
    return "number"
  }
  if (kind(ast) === "date") return false
  return ok
}

function formulaNumber(def: FormulaDef, env: Record<string, FVal>): number {
  try {
    const v = evalFormula(parseFormula(def.expression), env, def.excludeWeekends)
    if (v == null) return NaN
    if (typeof v === "boolean") return v ? 1 : 0
    if (typeof v === "object") return v.day
    return Number.isFinite(v) ? v : NaN
  } catch { return NaN }
}
const formulaHasDates = (def: FormulaDef) => def.refs.some((r) => getFieldType(r.field) === "date")

const MULTI_FIELDS = new Set<string>()
// Filled once MODULES exists — read through isMultiField, never before render.
function isMultiField(key: string): boolean {
  if (MULTI_FIELDS.size === 0) MODULES.forEach((m) => m.fields.forEach((f) => { if (f.multi) MULTI_FIELDS.add(makeFieldKey(m.name, f.name)) }))
  return MULTI_FIELDS.has(key)
}

// Which module a field belongs to (for detecting when a report spans more than one module).
function getFieldModule(key: string): string | null {
  const mod = fieldKeyModule(key)
  return MODULES.some((m) => m.name === mod) ? mod : null
}

// The full join graph, transcribed from MODULES.md's "Joins on:" lines. A lookup path is a
// property of the *relationship* between two modules, not of any one field pulled through it —
// most pairs have exactly one path, but a few (Task↔People, Task↔Sprint, Project↔Account,
// Forms↔Task, Expense↔People) have more than one column that can connect them, which is the
// real-world case the Lookups panel exists to resolve.
interface JoinEdge { from: string; to: string; label: string }

const JOIN_EDGES: JoinEdge[] = [
  { from: "Budget", to: "Account", label: "Company" },
  { from: "Budget", to: "Project", label: "Project" },

  { from: "Forms", to: "Account", label: "Company" },
  { from: "Forms", to: "Project", label: "Project" },
  { from: "Forms", to: "Task", label: "Task" },
  { from: "Forms", to: "People", label: "Submitted by" },

  { from: "People", to: "Account", label: "Company" },
  { from: "People", to: "Role", label: "Role" },
  { from: "People", to: "Capacity", label: "Team member" },

  { from: "Project", to: "Account", label: "Company" },
  { from: "Project", to: "Phase", label: "Current Phases" },
  { from: "Project", to: "Account", label: "Partner Company" },
  { from: "Project", to: "People", label: "Project owner" },
  { from: "Project", to: "People", label: "Project creator" },
  { from: "Project", to: "People", label: "Project member" },

  { from: "Task", to: "People", label: "Assignees" },
  { from: "Task", to: "Sprint", label: "Associated Sprints" },
  { from: "Task", to: "Account", label: "Company" },
  { from: "Task", to: "Sprint", label: "Current Sprint" },
  { from: "Task", to: "Epic", label: "Epic" },
  { from: "Task", to: "Phase", label: "Phase" },
  { from: "Task", to: "Budget", label: "Project Financials Budgets" },
  { from: "Task", to: "Project", label: "Project" },
  { from: "Task", to: "Team", label: "Teams" },

  { from: "Time tracking", to: "Account", label: "Company" },
  { from: "Time tracking", to: "Invoice", label: "Invoice" },
  { from: "Time tracking", to: "Budget", label: "Project Financials Budget" },
  { from: "Time tracking", to: "Project", label: "Project" },
  { from: "Time tracking", to: "Phase", label: "Project Phase" },
  { from: "Time tracking", to: "Role", label: "Role" },
  { from: "Time tracking", to: "Task", label: "Task" },
  { from: "Time tracking", to: "People", label: "Team member" },

  { from: "Actual financials", to: "Budget", label: "Budget" },
  { from: "Actual financials", to: "Account", label: "Customer" },
  { from: "Actual financials", to: "Project", label: "Project" },
  { from: "Actual financials", to: "Estimated financials", label: "Project" },
  { from: "Actual financials", to: "Role", label: "Role" },
  { from: "Actual financials", to: "Team", label: "Team" },
  { from: "Actual financials", to: "People", label: "Team member" },

  { from: "Allocations", to: "Budget", label: "Project Financials Budget" },
  { from: "Allocations", to: "Project", label: "Project" },
  { from: "Allocations", to: "Phase", label: "Project Phase" },
  { from: "Allocations", to: "Role", label: "Role" },
  { from: "Allocations", to: "Team", label: "Team" },
  { from: "Allocations", to: "People", label: "Team member" },
  { from: "Allocations", to: "Task", label: "Task" },

  { from: "Assignee effort", to: "Budget", label: "Project Financials Budget" },
  { from: "Assignee effort", to: "Project", label: "Project" },
  { from: "Assignee effort", to: "Task", label: "Task" },
  { from: "Assignee effort", to: "Team", label: "Team" },
  { from: "Assignee effort", to: "People", label: "Team member" },

  { from: "Backlog", to: "Epic", label: "Epics" },
  { from: "Backlog", to: "Project", label: "Projects" },

  { from: "Capacity", to: "Role", label: "Role" },
  { from: "Capacity", to: "People", label: "Team member" },

  { from: "Credit notes", to: "Account", label: "Company" },
  { from: "Credit notes", to: "Invoice", label: "Invoice" },
  { from: "Credit notes", to: "Project", label: "Projects" },

  { from: "Daily rollup", to: "Budget", label: "Budget" },
  { from: "Daily rollup", to: "Account", label: "Customer" },
  { from: "Daily rollup", to: "Project", label: "Project" },
  { from: "Daily rollup", to: "Role", label: "Role" },
  { from: "Daily rollup", to: "Team", label: "Team" },
  { from: "Daily rollup", to: "People", label: "Team member" },

  { from: "Epic", to: "People", label: "Epic Squad" },
  { from: "Epic", to: "Project", label: "Projects" },

  { from: "Estimated financials", to: "Budget", label: "Budget" },
  { from: "Estimated financials", to: "Account", label: "Customer" },
  { from: "Estimated financials", to: "Project", label: "Project" },
  { from: "Estimated financials", to: "Role", label: "Role" },
  { from: "Estimated financials", to: "Team", label: "Team" },
  { from: "Estimated financials", to: "People", label: "Team member" },

  { from: "Expense", to: "People", label: "Expense Owner" },
  { from: "Expense", to: "People", label: "All Approvers" },
  { from: "Expense", to: "Expense budget", label: "Expense Budget" },
  { from: "Expense", to: "Expense report", label: "Expense Report" },
  { from: "Expense", to: "Invoice", label: "Invoice" },
  { from: "Expense", to: "Budget", label: "Project Financials Budget" },
  { from: "Expense", to: "Project", label: "Project" },
  { from: "Expense", to: "Phase", label: "Project Phase" },
  { from: "Expense", to: "Task", label: "Task" },

  { from: "Expense budget", to: "Budget", label: "Project Financials Budget" },
  { from: "Expense budget", to: "Project", label: "Project" },

  { from: "Expense report", to: "People", label: "Expense Owner" },
  { from: "Expense report", to: "Project", label: "Project" },

  { from: "Invoice", to: "Account", label: "Company" },
  { from: "Invoice", to: "Budget", label: "Project Financials Budgets" },
  { from: "Invoice", to: "Project", label: "Projects" },

  { from: "Leave & holiday", to: "Role", label: "Role" },
  { from: "Leave & holiday", to: "People", label: "Team member" },

  { from: "Meeting", to: "Account", label: "Company" },

  { from: "Phase", to: "Account", label: "Companies" },
  { from: "Phase", to: "Project", label: "Project" },

  { from: "Policy checks", to: "Time tracking", label: "Entity" },

  { from: "Project members", to: "Project", label: "Project" },
  { from: "Project members", to: "People", label: "Team member" },

  { from: "Project teams", to: "Project", label: "Project" },
  { from: "Project teams", to: "Role", label: "Role" },
  { from: "Project teams", to: "Team", label: "Team" },

  { from: "Revenue entries", to: "Account", label: "Company" },
  { from: "Revenue entries", to: "Budget", label: "Project Financials Budget" },
  { from: "Revenue entries", to: "Project", label: "Project" },

  { from: "Signals", to: "Account", label: "Company" },
  { from: "Signals", to: "Meeting", label: "Meeting" },
  { from: "Signals", to: "People", label: "Reported By Users" },

  { from: "Sprint", to: "Epic", label: "Associated Epics" },
  { from: "Sprint", to: "Project", label: "Associated Projects" },
  { from: "Sprint", to: "People", label: "Sprint Squad" },

  { from: "Team membership", to: "Project", label: "Project" },
  { from: "Team membership", to: "Role", label: "Role" },
  { from: "Team membership", to: "Team", label: "Team" },
  { from: "Team membership", to: "People", label: "Team member" },
]

function modulePairKey(a: string, b: string): string {
  return [a, b].sort().join("::")
}

// Derived from JOIN_EDGES: every module pair that's ever connected, with the distinct
// column labels that connect them. A pair with 2+ labels is genuinely ambiguous.
const MODULE_RELATIONSHIP_PATHS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {}
  JOIN_EDGES.forEach(({ from, to, label }) => {
    const key = modulePairKey(from, to)
    if (!map[key]) map[key] = []
    if (!map[key].includes(label)) map[key].push(label)
  })
  return map
})()

// ── Team member roles ─────────────────────────────────────────────────────────────
// Every way a record points at a team member, per module. A Team member field picks one of the
// roles of the report's source module. The person each role names is read from the module's own
// person column (by name) or from an id the record carries.
interface PersonRole {
  /** Stored on the chip / filter. Unique across modules. */
  id: string
  module: string
  label: string
  idKey?: string
  nameKey?: string
  /** A list of ids: one record, several people. */
  idsKey?: string
  /** One record can name several people (the role can repeat a record's numbers). */
  many?: boolean
  /** Created by / Updated by: listed, but never the default. */
  audit?: boolean
}
const PERSON_ROLE_LIST: PersonRole[] = ([
  { module: "Task", label: "Assignees", idKey: "userId", many: true },
  { module: "Task", label: "Created by", nameKey: "Created by", audit: true },
  { module: "Phase", label: "Updated by", nameKey: "Updated by", audit: true },
  { module: "Project", label: "Project Owner", idKey: "ownerId" },
  { module: "Project", label: "Project members", idsKey: "teamIds", many: true },
  { module: "Project", label: "Created By", idKey: "createdById", audit: true },
  { module: "Account", label: "Account Owner", nameKey: "Account Owner" },
  { module: "Time tracking", label: "Team member", idKey: "userId" },
  { module: "Time tracking", label: "Submitted By", nameKey: "Submitted By" },
  { module: "Time tracking", label: "Approved By", nameKey: "Approved By" },
  { module: "Time tracking", label: "Rejected By", nameKey: "Rejected By" },
  { module: "Time tracking", label: "Created By", nameKey: "Created By", audit: true },
  { module: "Expense", label: "Expense owner", idKey: "userId" },
  { module: "Assignee effort", label: "Team member", idKey: "userId" },
  { module: "Assignee effort", label: "Created By", nameKey: "Created By", audit: true },
  { module: "Assignee effort", label: "Updated By", nameKey: "Updated By", audit: true },
  { module: "Allocations", label: "Team member", idKey: "userId" },
  { module: "Actual financials", label: "Team member", idKey: "userId" },
  { module: "Estimated financials", label: "Team member", idKey: "userId" },
  { module: "Capacity", label: "Team member", idKey: "userId" },
  { module: "Leave & holiday", label: "Team member", idKey: "userId" },
  { module: "Project members", label: "Team member", idKey: "userId" },
  { module: "Epic", label: "Epic Owner", nameKey: "Epic Owner" },
  { module: "Epic", label: "Epic Squad", nameKey: "Epic Squad", many: true },
  { module: "Sprint", label: "Sprint Owner", nameKey: "Sprint Owner" },
  { module: "Sprint", label: "Sprint Squad", nameKey: "Sprint Squad", many: true },
  { module: "Forms", label: "Submitted by", nameKey: "Submitted By" },
  { module: "Forms", label: "Updated By", nameKey: "Updated By", audit: true },
] as Omit<PersonRole, "id">[]).map((r) => ({ ...r, id: `${r.module} · ${r.label}` }))
const PERSON_ROLES: Record<string, PersonRole> = Object.fromEntries(PERSON_ROLE_LIST.map((r) => [r.id, r]))

// Reports saved before roles were grouped by module stored the bare relationship name.
const LEGACY_ROLE_IDS: Record<string, string> = {
  "Assignees": "Task · Assignees",
  "Project owner": "Project · Project Owner",
  "Project creator": "Project · Created By",
  "Project · Project owner": "Project · Project Owner",
  "Project · Created by": "Project · Created By",
  "Account · Company owner": "Account · Account Owner",
  "Time tracking · Submitted by": "Time tracking · Submitted By",
  "Time tracking · Approved by": "Time tracking · Approved By",
  "Time tracking · Rejected by": "Time tracking · Rejected By",
  "Time tracking · Created by": "Time tracking · Created By",
  "Assignee effort · Created by": "Assignee effort · Created By",
  "Assignee effort · Last updated by": "Assignee effort · Updated By",
  "Epic · Epic owner": "Epic · Epic Owner",
  "Epic · Epic squad": "Epic · Epic Squad",
  "Sprint · Sprint owner": "Sprint · Sprint Owner",
  "Sprint · Sprint squad": "Sprint · Sprint Squad",
  "Forms · Last edited by": "Forms · Updated By",
  "Project member": "Project · Project members",
  "Expense Owner": "Expense · Expense owner",
}
const normalizeRoleId = (id?: string) => (id ? LEGACY_ROLE_IDS[id] ?? id : id)

// A role's name on a chip or filter. Every role on offer belongs to the report's source, so the
// module needn't be repeated.
function roleDisplayName(id: string): string {
  return PERSON_ROLES[id]?.label ?? id
}


// The Team member roles on offer: every role of the report's SOURCE module, and only those — a
// task report reads people as the task names them. Offered once the source's record can be read
// from the grain (the grain is the source, or carries a key to it).
function personRoleOptions(grainModule: string, source?: string): string[] {
  const mod = source ?? grainModule
  if (mod !== grainModule) {
    const sample = (MODULE_ROWS[grainModule] ?? [])[0]
    if (!sample || !DIMENSION_ID_KEY[mod] || sample[DIMENSION_ID_KEY[mod]] === undefined) return []
  }
  return PERSON_ROLE_LIST.filter((r) => r.module === mod).map((r) => r.id)
}

// The relationship paths that could take you from the report's grain to this field's module.
// Zero or one means there is nothing to choose and the chip shows no role at all. A Team member
// field lists every role, grouped by module (see personRoleOptions).
function availableLookupPaths(grainModule: string, fieldKey: string, source?: string): string[] {
  const mod = fieldKeyModule(fieldKey)
  if (!mod || mod === grainModule) return []
  if (mod === "People") return personRoleOptions(grainModule, source)
  return MODULE_RELATIONSHIP_PATHS[modulePairKey(grainModule, mod)] ?? []
}

// The role used when the author hasn't picked one: the source's first role (owner / assignee /
// the person the record is for), never Created by or Updated by.
function defaultLookupPath(paths: string[]): string | undefined {
  return paths.find((p) => !PERSON_ROLES[p]?.audit) ?? paths[0]
}

// The role a chip is actually resolving through: its explicit choice, else the default. A single
// Team member role is still returned (there is no choice to show, but it decides who is read).
function effectiveLookupPath(grainModule: string, fieldKey: string, chosen?: string, source?: string): string | undefined {
  const paths = availableLookupPaths(grainModule, fieldKey, source)
  const c = normalizeRoleId(chosen)
  if (paths.length === 1 && PERSON_ROLES[paths[0]]) return paths[0]
  if (paths.length < 2) return undefined
  return c && paths.includes(c) ? c : defaultLookupPath(paths)
}

// A chip whose chosen role is no longer on offer (its module left the report) — it has fallen
// back to the default, and the author is told so.
function lookupFellBack(grainModule: string, fieldKey: string, chosen?: string, source?: string): boolean {
  const c = normalizeRoleId(chosen)
  if (!c || !PERSON_ROLES[c]) return false
  return !availableLookupPaths(grainModule, fieldKey, source).includes(c)
}

interface LookupRelationship {
  key: string
  label: string
  paths: string[]
}

function usedModuleRelationships(fields: PivotFields): LookupRelationship[] {
  const names = [...fields.columns, ...fields.rows, ...fields.values].map((item) => item.field)
  const modules = new Set<string>()
  names.forEach((n) => {
    const mod = getFieldModule(n)
    if (mod) modules.add(mod)
  })
  const mods = [...modules]
  const out: LookupRelationship[] = []
  for (let i = 0; i < mods.length; i++) {
    for (let j = i + 1; j < mods.length; j++) {
      const [a, b] = [mods[i], mods[j]].sort()
      const key = modulePairKey(a, b)
      const paths = MODULE_RELATIONSHIP_PATHS[key]
      if (paths) out.push({ key, label: `${a} ↔ ${b}`, paths })
    }
  }
  return out
}

// ── Synthetic dataset ────────────────────────────────────────────────────────────
// A small deterministic (seeded) relational dataset standing in for a real Rocketlane
// account, so every field in the catalog above resolves to a real, joined number
// instead of a per-cell hash. Generated once at module load from a fixed seed, so the
// numbers stay stable across reloads instead of reshuffling.

type Row = Record<string, any>

function makeRng(seed: number) {
  let a = seed >>> 0
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(20260817)
function randInt(min: number, max: number): number { return Math.floor(rng() * (max - min + 1)) + min }
function randFloat(min: number, max: number): number { return rng() * (max - min) + min }
function pick<T>(arr: T[]): T { return arr[randInt(0, arr.length - 1)] }
function pickWeighted<T>(pairs: [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v }
  return pairs[pairs.length - 1][0]
}
function pickSubset<T>(arr: T[], min: number, max: number): T[] {
  const n = Math.min(arr.length, randInt(min, max))
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randInt(0, i)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}
function addDays(date: Date, days: number): Date {
  const d = new Date(date); d.setDate(d.getDate() + days); return d
}
function randDate(from: Date, to: Date): Date {
  const lo = from.getTime(), hi = to.getTime()
  return new Date(hi > lo ? randInt(lo, hi) : lo)
}
let idCounter = 0
function nextId(prefix: string): string { return `${prefix}-${idCounter++}` }

const TODAY = new Date(2026, 7, 17) // matches this session's "current date"

// ── Name pools ──────────────────────────────────────────────────────────────────
const PERSON_NAMES = [
  "Alice Johnson", "Bob Martinez", "Carol White", "David Kim", "Emma Davis", "Frank Lee", "Grace Patel",
  "Henry Chen", "Isabel Rodriguez", "Jack Thompson", "Karen Nguyen", "Liam O'Brien", "Mia Anderson", "Noah Williams",
]
const COMPANY_NAMES = ["Acme Corp", "Globex", "Initech", "Umbrella Ltd", "Stark Industries", "Wayne Enterprises", "Oscorp", "Cyberdyne"]
const PROJECT_NAMES = [
  "Alpha Launch", "Beta Rollout", "Client Onboarding Q1", "Data Migration", "ERP Integration", "Firewall Upgrade",
  "GTM Redesign", "HR Portal", "Infrastructure Audit", "JIRA Migration", "Kubernetes Rollout", "Ledger Reconciliation",
]
const PHASE_NAME_POOL = ["Discovery", "Planning", "Design", "Build", "Testing", "Deployment", "Hypercare"]
const TASK_SUBJECTS = [
  "Fix login bug", "Design onboarding flow", "Migrate database", "Update API docs", "QA regression pass",
  "Set up CI pipeline", "Conduct stakeholder review", "Draft SOW", "Implement SSO", "Optimize query performance",
  "Prepare training material", "Reconcile invoices", "Audit access logs", "Create dashboard mockups",
  "Write integration tests", "Deploy to staging", "Configure monitoring alerts", "Migrate legacy records",
  "Review security policy", "Finalize contract terms", "Refactor auth module", "Set up VPN access",
  "Draft release notes", "Benchmark API latency", "Clean up test fixtures",
]
const ROLE_NAMES = ["Project Manager", "Consultant", "Developer", "Designer", "QA Engineer", "Business Analyst"]

// ── Roles ───────────────────────────────────────────────────────────────────────
const ROLES: Row[] = ROLE_NAMES.map((name) => {
  const id = nextId("role")
  const costRate = randInt(45, 140)
  return {
    id, roleId: id,
    "Role name": name,
    "Role Type": pick(["Internal", "Partner"]),
    "Cost rate": costRate,
    "Used By Partners": rng() < 0.2,
    "Available capacity": randInt(20, 40),
    "Utilisation": randInt(55, 95),
    "Billable utilisation": randInt(45, 90),
    "Total capacity": 40,
    "Planned utilisation": randInt(60, 100),
    billRate: Math.round(costRate * 1.6),
  }
})
const ROLES_BY_ID: Record<string, Row> = Object.fromEntries(ROLES.map((r) => [r.id, r]))

// ── People ──────────────────────────────────────────────────────────────────────
const PEOPLE: Row[] = PERSON_NAMES.map((name) => {
  const id = nextId("person")
  const role = pick(ROLES)
  return {
    id, userId: id, roleId: role.id,
    "Team member name": name,
    "Cost rate": role["Cost rate"],
    "Team member type": pickWeighted<string>([["Employee", 7], ["Contractor", 2], ["Partner", 1]]),
    "Team member status": pickWeighted<string>([["Active", 8], ["On Leave", 1], ["Inactive", 1]]),
    "Role": role["Role name"],
    "Utilisation": randInt(50, 95),
    "Total capacity": 40,
    "Available capacity": randInt(2, 20),
    "Billable utilisation": randInt(40, 90),
    "Effective capacity": randInt(30, 40),
    "Planned utilisation": randInt(60, 100),
    "Base Capacity": 40,
  }
})
PEOPLE.forEach((p, i) => { p["Timesheet approver"] = PEOPLE[i % 3]?.["Team member name"] ?? PEOPLE[0]["Team member name"] })
const PEOPLE_BY_ID: Record<string, Row> = Object.fromEntries(PEOPLE.map((p) => [p.id, p]))

// ── Accounts ────────────────────────────────────────────────────────────────────
const ACCOUNTS: Row[] = COMPANY_NAMES.map((name) => {
  const id = nextId("account")
  return {
    id, accountId: id,
    "Company name": name,
    "Company owner": pick(PERSON_NAMES),
    "ARR": randInt(50_000, 2_000_000),
    "Company stage": pickWeighted<string>([["Active", 5], ["Renewal", 2], ["At Risk", 1], ["Prospect", 1], ["Churned", 1]]),
    "Company health": pickWeighted<string>([["Healthy", 6], ["At Risk", 3], ["Critical", 1]]),
    "Last activity": randDate(addDays(TODAY, -30), TODAY),
    "Company type": pickWeighted<string>([["Customer", 7], ["Partner", 2], ["Prospect", 1]]),
    "Capacity": randInt(200, 800),
    "Capacity Minutes": randInt(200, 800) * 60,
    "Is active": rng() < 0.9,
    "Is strategic": rng() < 0.3,
    "Contract Renewal Date": randDate(addDays(TODAY, 30), addDays(TODAY, 300)),
  }
})
const ACCOUNTS_BY_ID: Record<string, Row> = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]))

// ── Projects ────────────────────────────────────────────────────────────────────
const PROJECTS: Row[] = PROJECT_NAMES.map((name) => {
  const id = nextId("project")
  const account = pick(ACCOUNTS)
  const owner = pick(PEOPLE)
  const status = pickWeighted<string>([["In Progress", 5], ["Completed", 3], ["Not Started", 1], ["On Hold", 1], ["Cancelled", 1]])
  const startDate = randDate(new Date(2025, 9, 1), new Date(2026, 5, 1))
  const plannedDuration = randInt(45, 220)
  const dueDate = addDays(startDate, plannedDuration)
  const progress = status === "Completed" ? 100 : status === "Not Started" ? 0 : status === "Cancelled" ? randInt(5, 40) : randInt(15, 90)
  const projectFee = randInt(20_000, 400_000)
  const projectBudget = Math.round(projectFee * randFloat(0.8, 1.1))
  const cost = Math.round(projectBudget * (progress / 100) * randFloat(0.6, 0.95))
  const revenue = Math.round(projectFee * (progress / 100))
  const team = pickSubset(PEOPLE, 3, 7)
  if (!team.includes(owner)) team.push(owner)
  return {
    id, projectId: id, accountId: account.id, ownerId: owner.id,
    createdById: (team.filter((p) => p.id !== owner.id)[0] ?? owner).id,
    teamIds: team.map((p) => p.id),
    "Project Name": name,
    "Customer": account["Company name"],
    "ARR": randInt(20_000, 600_000),
    "Billing type": pick(["Fixed Fee", "Time & Materials", "Retainer", "Milestone-based"]),
    "Project owner": owner["Team member name"],
    "Budget consumed %": Math.min(100, Math.round((cost / projectBudget) * 100)),
    "Estimate to completion (ETC)": Math.max(0, projectBudget - cost),
    "Estimate at completion (EAC)": Math.round(cost + Math.max(0, projectBudget - cost) * randFloat(0.9, 1.15)),
    "Project status": status,
    "Project currency": pick(["USD", "EUR", "GBP", "INR", "AUD"]),
    "Due Date": dueDate,
    "Start Date": startDate,
    "Project Fee": projectFee,
    "Available capacity": randInt(20, 160),
    "Project Budget": projectBudget,
    "Billable utilisation": randInt(45, 90),
    "Progress Percent": progress,
    "Project Cost": cost,
    "Project Profit": revenue - cost,
    "Project Revenue": revenue,
  }
})
const PROJECTS_BY_ID: Record<string, Row> = Object.fromEntries(PROJECTS.map((p) => [p.id, p]))

// ── Phases ──────────────────────────────────────────────────────────────────────
const PHASES: Row[] = PROJECTS.flatMap((project) => {
  const names = pickSubset(PHASE_NAME_POOL, 3, 5).sort((a, b) => PHASE_NAME_POOL.indexOf(a) - PHASE_NAME_POOL.indexOf(b))
  const span = (project["Due Date"].getTime() - project["Start Date"].getTime()) / names.length
  return names.map((name, i) => {
    const id = nextId("phase")
    const start = new Date(project["Start Date"].getTime() + span * i)
    const due = new Date(project["Start Date"].getTime() + span * (i + 1))
    const isPast = due.getTime() < TODAY.getTime()
    const status = project["Project status"] === "Completed" || isPast
      ? "Completed"
      : i === 0 ? "Completed" : pickWeighted<string>([["In Progress", 3], ["Not Started", 2], ["On Hold", 1]])
    return {
      id, phaseId: id, projectId: project.id, accountId: project.accountId,
      "Project phase": name,
      "Phase status": status,
      "Completed at": status === "Completed" ? due : null,
      "Due date": due,
      "Start date": start,
      "Start date actual": start,
    }
  })
})
const PHASES_BY_ID: Record<string, Row> = Object.fromEntries(PHASES.map((p) => [p.id, p]))
const PHASES_BY_PROJECT: Record<string, Row[]> = {}
PHASES.forEach((p) => { (PHASES_BY_PROJECT[p.projectId] ??= []).push(p) })

// ── Tasks ───────────────────────────────────────────────────────────────────────
const TASKS: Row[] = PROJECTS.flatMap((project) => {
  const phases = PHASES_BY_PROJECT[project.id] ?? []
  const team: Row[] = project.teamIds.map((id: string) => PEOPLE_BY_ID[id])
  const taskCount = randInt(6, 14)
  return Array.from({ length: taskCount }, () => {
    const id = nextId("task")
    const phase = pick(phases)
    const assignee = pick(team)
    // Kept only so the random sample data stays the same as before Responsible was removed.
    const others = team.filter((p) => p.id !== assignee.id)
    if (others.length > 0) pick(others)
    const status = pickWeighted<string>([["Completed", 4], ["In progress", 3], ["To do", 2], ["Blocked", 1]])
    const effort = randInt(4, 80)
    const start = randDate(phase["Start date"], phase["Due date"])
    const due = addDays(start, randInt(3, 21))
    const isDone = status === "Completed"
    const progress = isDone ? 100 : status === "To do" ? 0 : status === "Blocked" ? randInt(0, 30) : randInt(10, 90)
    return {
      id, taskId: id, projectId: project.id, phaseId: phase.id, accountId: project.accountId,
      userId: assignee.id, roleId: assignee.roleId,
      "Task name": pick(TASK_SUBJECTS),
      "Project phase": phase["Project phase"],
      "Effort": effort,
      "Status": status,
      "Risk": rng() < 0.15,
      "Billable": rng() < 0.82,
      "Progress": progress,
      "Priority": pickWeighted<string>([["Medium", 4], ["High", 3], ["Low", 2], ["Urgent", 1]]),
      "Completed at": isDone ? due : null,
      "RevRec Amount": rng() < 0.2 ? randInt(500, 8000) : 0,
      "RevRec Task": rng() < 0.2,
      "Due date": due,
      "Start date": start,
      "Completed tasks": isDone ? 1 : 0,
      "Remaining hours": isDone ? 0 : Math.round(effort * (1 - progress / 100)),
      "Assignees": assignee["Team member name"],
    }
  })
})
const TASKS_BY_ID: Record<string, Row> = Object.fromEntries(TASKS.map((t) => [t.id, t]))
const TASKS_BY_PROJECT: Record<string, Row[]> = {}
TASKS.forEach((t) => { (TASKS_BY_PROJECT[t.projectId] ??= []).push(t) })

// ── Time tracking entries ────────────────────────────────────────────────────────
const TIME_ENTRIES: Row[] = TASKS.flatMap((task) => {
  if (task["Status"] === "To do") return []
  const entryCount = task["Status"] === "Blocked" ? randInt(0, 3) : Math.max(1, Math.round(task["Effort"] / randFloat(2, 4)))
  const project = PROJECTS_BY_ID[task.projectId]
  const windowEnd = task["Completed at"] ?? TODAY
  const windowStart = task["Start date"] < windowEnd ? task["Start date"] : addDays(windowEnd, -14)
  return Array.from({ length: entryCount }, () => {
    const id = nextId("time")
    const useOther = rng() >= 0.85
    const userId = useOther ? pick<Row>(project.teamIds.map((pid: string) => PEOPLE_BY_ID[pid])).id : task.userId
    const person = PEOPLE_BY_ID[userId]
    const role = ROLES_BY_ID[person.roleId]
    const date = randDate(windowStart, windowEnd > TODAY ? TODAY : windowEnd)
    const trackedMinutes = randInt(30, 480)
    const billableMinutes = task["Billable"] ? Math.round(trackedMinutes * randFloat(0.7, 1)) : 0
    const nonBillableMinutes = trackedMinutes - billableMinutes
    const costRate = role["Cost rate"]
    const billRate = role.billRate
    const actualCost = Math.round((trackedMinutes / 60) * costRate)
    const actualRevenue = Math.round((billableMinutes / 60) * billRate)
    const approvedStatus = date < addDays(TODAY, -14)
      ? pickWeighted<string>([["Approved", 9], ["Rejected", 1]])
      : pickWeighted<string>([["Approved", 5], ["Pending", 4], ["Rejected", 1]])
    return {
      id, projectId: task.projectId, phaseId: task.phaseId, taskId: task.id, accountId: task.accountId,
      userId, roleId: person.roleId,
      "Activity Name": task["Task name"],
      "Tracked Hours": trackedMinutes,
      "Billable Hours": billableMinutes,
      "Billable": task["Billable"],
      "Category": randInt(1, 5),
      "Non Billable Hours": nonBillableMinutes,
      "Approved Status": approvedStatus,
      "Entry Type": pick(["Manual", "Timer", "Imported"]),
      "Created date": date,
      "Actual Cost": actualCost,
      "Invoiced": approvedStatus === "Approved" && rng() < 0.7,
      "Approved Hours": approvedStatus === "Approved" ? trackedMinutes : 0,
      "Bill rate": billRate,
      "Cost rate": costRate,
      "Unapproved Hours": approvedStatus !== "Approved" ? trackedMinutes : 0,
      "Actual Revenue": actualRevenue,
      "Status": approvedStatus === "Approved" ? "Approved" : approvedStatus === "Pending" ? "Submitted" : "Rejected",
      "Actual Margin": actualRevenue - actualCost,
      "Actual Profit": actualRevenue - actualCost,
      "Rejected Hours": approvedStatus === "Rejected" ? trackedMinutes : 0,
    }
  })
})
const TIME_BY_TASK: Record<string, Row[]> = {}
TIME_ENTRIES.forEach((t) => { (TIME_BY_TASK[t.taskId] ??= []).push(t) })

// ── Assignee effort / Actual financials / Estimated financials / Expense (per task) ──
const ASSIGNEE_EFFORT: Row[] = TASKS.map((task) => ({
  id: nextId("aeff"), projectId: task.projectId, phaseId: task.phaseId, taskId: task.id, userId: task.userId, roleId: task.roleId, accountId: task.accountId,
  "Assignee effort": task["Effort"],
}))

// Revenue and cost are earned when time is logged, so a task's actuals are kept per month of its
// entries rather than as one lump. A single date per task would put all of its revenue in one
// month, and a timeline would then disagree with Tracked Hours for the very same period.
// Derived from the entries' own dates — no random draws — so nothing generated later shifts.
const ACTUAL_FINANCIALS: Row[] = TASKS.flatMap((task) => {
  const entries = TIME_BY_TASK[task.id] ?? []
  const role = ROLES_BY_ID[task.roleId]
  const byMonth = new Map<string, Row[]>()
  entries.forEach((e) => {
    const d: Date = e["Created date"]
    const key = `${d.getFullYear()}-${d.getMonth()}`
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key)!.push(e)
  })
  const groups: Row[][] = byMonth.size > 0 ? [...byMonth.values()] : [[]]
  return groups.map((group) => {
    const revenue = group.reduce((s, e) => s + e["Actual Revenue"], 0)
    const cost = group.reduce((s, e) => s + e["Actual Cost"], 0)
    const billableHours = group.reduce((s, e) => s + e["Billable Hours"], 0)
    const latest = group.reduce<Date | null>((m, e) => (!m || e["Created date"] > m ? e["Created date"] : m), null)
    return {
      id: nextId("actfin"), projectId: task.projectId, phaseId: task.phaseId, taskId: task.id, userId: task.userId, roleId: task.roleId, accountId: task.accountId,
      "Recognised date": latest ?? task["Start date"],
      "Actual Revenue": revenue,
      "Actual Cost": cost,
      "Actual Margin": revenue - cost,
      "Actual Profit": revenue - cost,
      "Actual Expense Cost": 0, // backfilled once EXPENSE exists
      "Actual Time Cost": cost,
      "Bill Rate": role.billRate,
      "Billable Hours": billableHours,
    }
  })
})
// Per-task totals. The rows above are per task per month, so this sums them rather than
// indexing one row per task, which would quietly keep only the last month.
const ACTUAL_FIN_BY_TASK: Record<string, Row> = {}
ACTUAL_FINANCIALS.forEach((r) => {
  const t = (ACTUAL_FIN_BY_TASK[r.taskId] ??= { "Actual Revenue": 0, "Actual Cost": 0 })
  t["Actual Revenue"] += r["Actual Revenue"]
  t["Actual Cost"] += r["Actual Cost"]
})

const ESTIMATED_FINANCIALS: Row[] = TASKS.map((task) => {
  const role = ROLES_BY_ID[task.roleId]
  const effort = task["Effort"]
  const estRevenue = Math.round(effort * role.billRate)
  const estCost = Math.round(effort * role["Cost rate"])
  const hardHrs = Math.round(effort * 0.7)
  const softHrs = effort - hardHrs
  return {
    id: nextId("estfin"), projectId: task.projectId, phaseId: task.phaseId, taskId: task.id, userId: task.userId, roleId: task.roleId, accountId: task.accountId,
    // An estimate belongs to when the work is planned to happen.
    "Planned date": task["Start date"],
    "Estimated Revenue": estRevenue,
    "Estimated Cost": estCost,
    "Allocated Hours": effort,
    "Estimated Margin": estRevenue - estCost,
    "Estimated Profit": estRevenue - estCost,
    "Hard Allocated Hours": hardHrs,
    "Soft Allocated Hours": softHrs,
    "Bill Rate": role.billRate,
  }
})
const ESTIMATED_FIN_BY_TASK: Record<string, Row> = Object.fromEntries(ESTIMATED_FINANCIALS.map((r) => [r.taskId, r]))

const EXPENSE: Row[] = TASKS.flatMap((task) => {
  if (rng() > 0.35) return []
  const count = randInt(1, 2)
  const project = PROJECTS_BY_ID[task.projectId]
  return Array.from({ length: count }, () => {
    const amount = randInt(20, 800)
    const billableAmount = task["Billable"] ? Math.round(amount * randFloat(0.7, 1)) : 0
    return {
      // The expense owner is the task's assignee: derived, not drawn, so later seeded data is unchanged.
      id: nextId("exp"), projectId: task.projectId, phaseId: task.phaseId, taskId: task.id, accountId: task.accountId,
      userId: task.userId, roleId: PEOPLE_BY_ID[task.userId]?.roleId,
      "Amount": amount,
      "Billable Amount": billableAmount,
      "Currency": project["Project currency"],
      "Expense status": pick(["Submitted", "Approved", "Reimbursed", "Rejected"]),
      "Reimburse To Source Type": pick(["Company Card", "Personal", "Client Billed"]),
      "Non Billable Amount": amount - billableAmount,
      "Non Reimbursable Amount": Math.round(amount * 0.05),
      "Reimbursable Amount": Math.round(amount * 0.95),
    }
  })
})
const EXPENSE_BY_TASK: Record<string, Row[]> = {}
EXPENSE.forEach((e) => { (EXPENSE_BY_TASK[e.taskId] ??= []).push(e) })
// A task now has a row per month, so its expenses go on one of them — the latest — rather than
// being counted again on every month.
const LATEST_ACTUAL_BY_TASK: Record<string, Row> = {}
ACTUAL_FINANCIALS.forEach((r) => {
  const cur = LATEST_ACTUAL_BY_TASK[r.taskId]
  if (!cur || r["Recognised date"] > cur["Recognised date"]) LATEST_ACTUAL_BY_TASK[r.taskId] = r
})
Object.values(LATEST_ACTUAL_BY_TASK).forEach((r) => {
  r["Actual Expense Cost"] = (EXPENSE_BY_TASK[r.taskId] ?? []).reduce((s, e) => s + e["Amount"], 0)
})

// ── Allocations (per project × team member) ──────────────────────────────────────
const ALLOCATIONS: Row[] = PROJECTS.flatMap((project) => {
  const members: Row[] = project.teamIds.map((id: string) => PEOPLE_BY_ID[id])
  const projectTasks = TASKS_BY_PROJECT[project.id] ?? []
  const pStart: Date = project["Start Date"]
  const span = Math.max(0, (project["Due Date"].getTime() - pStart.getTime()) / 86400000)
  return members.map((person: Row, mi: number) => {
    const personTasks = projectTasks.filter((t) => t.userId === person.id)
    const repTask = personTasks[0] ?? projectTasks[0]
    const allocatedMins = randInt(400, 2400)
    return {
      id: nextId("alloc"), projectId: project.id, phaseId: repTask?.phaseId, taskId: repTask?.id, userId: person.id, roleId: person.roleId, accountId: project.accountId,
      // Spread across the project's span by position, not by a random draw, so the seeded data
      // generated after this stays exactly as it was.
      "Allocation date": addDays(pStart, Math.round((span * (mi + 0.5)) / Math.max(1, members.length))),
      "Allocated Mins Raw": allocatedMins,
      "Allocation Type": pick(["Hard", "Soft"]),
      "Is Billable": rng() < 0.75,
      "Allocated hours": Math.round(allocatedMins / 60),
      "Hard allocated hours": Math.round((allocatedMins * 0.7) / 60),
      "Soft allocated hours": Math.round((allocatedMins * 0.3) / 60),
      "Work Type": pick(["Billable Work", "Internal", "Admin"]),
      "Allocated Seconds": allocatedMins * 60,
    }
  })
})

// ── Budget / Invoice (1:1 per project, simplified) ───────────────────────────────
const BUDGETS: Row[] = PROJECTS.map((project) => {
  const projectTasks = TASKS_BY_PROJECT[project.id] ?? []
  const trackedMinutes = projectTasks.reduce((s, t) => s + (TIME_BY_TASK[t.id] ?? []).reduce((ss, e) => ss + e["Tracked Hours"], 0), 0)
  const actualCost = projectTasks.reduce((s, t) => s + (ACTUAL_FIN_BY_TASK[t.id]?.["Actual Cost"] ?? 0), 0)
  const actualRevenue = projectTasks.reduce((s, t) => s + (ACTUAL_FIN_BY_TASK[t.id]?.["Actual Revenue"] ?? 0), 0)
  const estCost = projectTasks.reduce((s, t) => s + (ESTIMATED_FIN_BY_TASK[t.id]?.["Estimated Cost"] ?? 0), 0)
  const estRevenue = projectTasks.reduce((s, t) => s + (ESTIMATED_FIN_BY_TASK[t.id]?.["Estimated Revenue"] ?? 0), 0)
  const budgetedHours = projectTasks.reduce((s, t) => s + t["Effort"], 0)
  return {
    id: nextId("budget"), projectId: project.id, accountId: project.accountId,
    "Budget name": `${project["Project Name"]} Budget`,
    "Project Budget": project["Project Budget"],
    "Budget Tracked Minutes": trackedMinutes,
    "Budget Remaining Minutes": Math.max(0, budgetedHours * 60 - trackedMinutes),
    "Estimate At Completion": project["Estimate at completion (EAC)"],
    "RevRec type": pick(["Milestone", "Percentage of completion", "Time & materials"]),
    "Budgeted Hours": budgetedHours,
    "Contract type": project["Billing type"],
    "Is default": true,
    "Budget End Date": project["Due Date"],
    "Budget Start Date": project["Start Date"],
    "Budget Actual Cost": actualCost,
    "Budget Actual Revenue": actualRevenue,
    "Budget Estimated Cost": estCost,
    "Budget Estimated Revenue": estRevenue,
  }
})
const BUDGET_BY_PROJECT: Record<string, Row> = Object.fromEntries(BUDGETS.map((b) => [b.projectId, b]))

const INVOICES: Row[] = PROJECTS.map((project, idx) => {
  const amount = Math.round(project["Project Fee"] * randFloat(0.3, 1))
  const outstandingFrac = randFloat(0, 0.4)
  const amountOutstanding = Math.round(amount * outstandingFrac)
  return {
    id: nextId("invoice"), projectId: project.id, accountId: project.accountId,
    "Invoice number": `INV-${1000 + idx}`,
    "Amount": amount,
    "Amount Outstanding": amountOutstanding,
    "Invoice status": amountOutstanding === 0 ? "Paid" : outstandingFrac > 0.2 ? "Overdue" : "Sent",
    "Date of Issue": randDate(project["Start Date"], TODAY),
    "Payment status": amountOutstanding === 0 ? "Paid" : amountOutstanding < amount ? "Partially Paid" : "Unpaid",
    "Paid Amount": amount - amountOutstanding,
    "Currency": project["Project currency"],
  }
})
const INVOICE_BY_PROJECT: Record<string, Row> = Object.fromEntries(INVOICES.map((i) => [i.projectId, i]))

// ── Project members / Daily rollup / Epic / Sprint / Forms / Meeting / Revenue entries ──
const PROJECT_MEMBERS: Row[] = PROJECTS.flatMap((project) => {
  const members: Row[] = project.teamIds.map((id: string) => PEOPLE_BY_ID[id])
  return members.map((person: Row, i: number) => ({
    id: nextId("pmember"), projectId: project.id, userId: person.id, accountId: project.accountId,
    ownerId: project.ownerId, createdById: project.createdById,
    "Source type": i === 0 ? "Owner" : pick(["Team Member", "Stakeholder"]),
    "Active": rng() < 0.92,
    "Is default": i === 0,
    "Joined at": addDays(project["Start Date"], randInt(0, 5)),
  }))
})

const DAILY_ROLLUP: Row[] = PROJECTS.flatMap((project) => {
  const start: Date = project["Start Date"] < TODAY ? project["Start Date"] : addDays(TODAY, -60)
  const end: Date = project["Due Date"] < TODAY ? project["Due Date"] : TODAY
  const weeks = Math.max(1, Math.round((end.getTime() - start.getTime()) / (7 * 86400000)))
  const projectTasks = TASKS_BY_PROJECT[project.id] ?? []
  return Array.from({ length: Math.min(weeks, 20) }, (_, w) => {
    const weekStart = addDays(start, w * 7)
    const weekEnd = addDays(weekStart, 7)
    const weekEntries = projectTasks.flatMap((t) => (TIME_BY_TASK[t.id] ?? []).filter((e) => e["Created date"] >= weekStart && e["Created date"] < weekEnd))
    const cost = weekEntries.reduce((s, e) => s + e["Actual Cost"], 0)
    const revenue = weekEntries.reduce((s, e) => s + e["Actual Revenue"], 0)
    const trackedMin = weekEntries.reduce((s, e) => s + e["Tracked Hours"], 0)
    const person: Row = pick<Row>(project.teamIds.map((id: string) => PEOPLE_BY_ID[id]))
    return {
      id: nextId("rollup"), projectId: project.id, accountId: project.accountId, userId: person.id, roleId: person.roleId,
      "Billable Utilisation": randInt(40, 90),
      "Capacity in minutes": 40 * 60,
      "Utilisation": randInt(50, 95),
      "Actual Cost": cost,
      "Actual Margin": revenue - cost,
      "Actual Revenue": revenue,
      "Actual profit": revenue - cost,
      "Allocated Hours": Math.round(trackedMin / 60),
      "Bill rate": ROLES_BY_ID[person.roleId].billRate,
      "Cost rate": ROLES_BY_ID[person.roleId]["Cost rate"],
      "Estimated Margin": Math.round((revenue - cost) * randFloat(0.9, 1.1)),
      "Estimated Profit": Math.round((revenue - cost) * randFloat(0.9, 1.1)),
      "Estimated Revenue": Math.round(revenue * randFloat(0.9, 1.15)),
      "Estimated cost": Math.round(cost * randFloat(0.85, 1.1)),
      "Hard Allocated Hours": Math.round((trackedMin * 0.7) / 60),
    }
  })
})

const EPIC: Row[] = PROJECTS.filter(() => rng() < 0.5).flatMap((project) => {
  const count = randInt(1, 2)
  const projectTasks = TASKS_BY_PROJECT[project.id] ?? []
  const effort = projectTasks.reduce((s, t) => s + t["Effort"], 0)
  const tracked = projectTasks.reduce((s, t) => s + (TIME_BY_TASK[t.id] ?? []).reduce((ss, e) => ss + e["Tracked Hours"], 0), 0)
  return Array.from({ length: count }, (_, i) => ({
    id: nextId("epic"), projectId: project.id, accountId: project.accountId,
    "Epic name": `${project["Project Name"]} Epic ${i + 1}`,
    "Epic owner": project["Project owner"],
    "Epic squad": pick<Row>(project.teamIds.map((id: string) => PEOPLE_BY_ID[id]))["Team member name"],
    "Epic status": pick(["Open", "In Progress", "Done"]),
    "Priority str": pick(["Low", "Medium", "High"]),
    "Effort": effort,
    "Task progress": randInt(20, 100),
    "Tracked hours": Math.round(tracked / 60),
  }))
})

const SPRINT: Row[] = PROJECTS.filter(() => rng() < 0.5).flatMap((project) => {
  const count = randInt(2, 3)
  return Array.from({ length: count }, (_, i) => ({
    id: nextId("sprint"), projectId: project.id, accountId: project.accountId,
    "Sprint name": `Sprint ${i + 1}`,
    "Sprint owner": project["Project owner"],
    "Sprint squad": pick<Row>(project.teamIds.map((id: string) => PEOPLE_BY_ID[id]))["Team member name"],
    "Sprint status": pick(["Planned", "Active", "Completed"]),
    "Sprint type": pick(["Regular", "Hotfix"]),
    "Actual duration": 80,
    "Duration": 80,
    "Effort in minutes": randInt(2000, 4800),
  }))
})

const FORMS: Row[] = PROJECTS.filter(() => rng() < 0.4).flatMap((project) => {
  const count = randInt(1, 2)
  return Array.from({ length: count }, () => ({
    id: nextId("form"), projectId: project.id, accountId: project.accountId,
    "Template Name": pick(["Kickoff Questionnaire", "Client Feedback Form", "Change Request", "Risk Assessment"]),
    "Submission Date": randDate(project["Start Date"], TODAY),
    "Submitted By": pick<Row>(project.teamIds.map((id: string) => PEOPLE_BY_ID[id]))["Team member name"],
    "Template Version Id": `v${randInt(1, 3)}`,
    "Answer Id": randInt(1000, 9999),
  }))
})

const MEETING: Row[] = ACCOUNTS.flatMap((account) => {
  const count = randInt(2, 5)
  return Array.from({ length: count }, () => ({
    id: nextId("meeting"), accountId: account.id,
    "Meeting name": pick(["QBR", "Kickoff Call", "Status Sync", "Renewal Discussion", "Escalation Call"]),
    "Meeting type": pick(["Internal", "External"]),
    "Duration seconds": randInt(1800, 5400),
    "Deal stage": pick(["Discovery", "Proposal", "Negotiation", "Closed Won"]),
    "Meeting status": pick(["Completed", "Scheduled", "Cancelled"]),
    "Pipeline status": pick(["Open", "Closed"]),
    "Source label": pick(["Zoom", "Google Meet", "In-person"]),
    "Is transcript available": rng() < 0.6,
  }))
})

const REVENUE_ENTRIES: Row[] = BUDGETS.flatMap((budget) => {
  const count = randInt(1, 2)
  return Array.from({ length: count }, () => ({
    id: nextId("revenue"), projectId: budget.projectId, accountId: budget.accountId, budgetId: budget.id,
    "Revenue to recognise": randInt(2000, 60000),
    "Amount (Account Currency)": randInt(2000, 60000),
    "End Date": budget["Budget End Date"],
    "Start Date": budget["Budget Start Date"],
  }))
})

const LEAVE_HOLIDAY: Row[] = PEOPLE.flatMap((person) => {
  const count = randInt(3, 8)
  return Array.from({ length: count }, () => {
    const sourceType = pick(["Holiday", "Sick Leave", "Vacation", "Unpaid"])
    const duration = randInt(4, 40)
    return {
      id: nextId("leave"), userId: person.id, roleId: person.roleId,
      "Total leave": duration,
      "Holiday": sourceType === "Holiday" ? duration : 0,
      "Timeoff": sourceType !== "Holiday" ? duration : 0,
      "Source Type": sourceType,
      "Duration": duration,
      "Date": randDate(addDays(TODAY, -180), addDays(TODAY, 60)),
    }
  })
})

const CAPACITY: Row[] = PEOPLE.flatMap((person) => {
  const weeks = 18
  return Array.from({ length: weeks }, (_, w) => {
    const status = rng() < 0.08 ? "On Leave" : "Active"
    return {
      id: nextId("capacity"), userId: person.id, roleId: person.roleId,
      "Team member status": status,
      "Capacity": status === "On Leave" ? randInt(0, 16) : 40,
      "Date": addDays(TODAY, (w - weeks + 2) * 7),
    }
  })
})

// ── Module → rows, and the join/grain machinery that resolves any field from any row ──
// ── Form submissions: answers ─────────────────────────────────────────────────────
// Its own seeded generator, and run after every other generator, so adding answers shifts no
// other module's numbers. Each submission is tied to a task on its project, and to the person who
// submitted it, so Task / Phase / People resolve as plain lookups. More submissions are added per
// project than the base set so a template has enough answers to group on.
const formRng = makeRng(20261027)
const fInt = (min: number, max: number) => Math.floor(formRng() * (max - min + 1)) + min
const fPick = <T,>(arr: T[]): T => arr[fInt(0, arr.length - 1)]
const fSubset = <T,>(arr: T[], min: number, max: number): T[] =>
  [...arr].sort(() => formRng() - 0.5).slice(0, Math.min(arr.length, fInt(min, max)))

function formAnswer(q: FormQuestion, field: FormAnswerField, team: Row[]): any {
  if (formRng() < 0.12) return field.multi ? [] : null // left blank
  const opts = q.options ?? []
  switch (q.kind) {
    case "radio": case "dropdown": case "singleGrid": return fPick(opts)
    case "checkbox": case "multiDropdown": case "multiGrid": return fSubset(opts, 1, 3).sort((a, b) => opts.indexOf(a) - opts.indexOf(b))
    case "user": return fPick(team)["Team member name"]
    case "multiUser": return fSubset(team, 1, 3).map((p) => p["Team member name"])
    case "rating": return fInt(1, 5)
    case "number": return fInt(1, q.text === "Team size" ? 40 : 60)
    case "currency": return fInt(2, 80) * 500
    case "percent": return fInt(1, 19) * 5
    case "date": return addDays(TODAY, fInt(-60, 120))
    case "email": return `${fPick(["ops", "pm", "cs", "it"])}@${fPick(COMPANY_NAMES).toLowerCase().replace(/[^a-z]/g, "")}.com`
    case "attachment": {
      const files = fInt(1, 4)
      return field.part === "count" ? files : true
    }
    default: return fPick(["Looks good so far", "Need more training sessions", "Timeline feels tight", "Great collaboration", "Waiting on data migration"])
  }
}

function fillFormSubmission(row: Row, project: Row): void {
  const template = FORM_TEMPLATES.find((t) => t.name === row["Template Name"]) ?? FORM_TEMPLATES[0]
  const team: Row[] = project.teamIds.map((id: string) => PEOPLE_BY_ID[id])
  const task = fPick(TASKS_BY_PROJECT[project.id] ?? [])
  const submitter = PEOPLE.find((p) => p["Team member name"] === row["Submitted By"]) ?? fPick(team)
  row.taskId = task?.id ?? null
  row.phaseId = task?.phaseId ?? null
  row.userId = submitter.id
  row["Submitted By"] = submitter["Team member name"]
  row["Template Version"] = row["Template Version Id"]
  template.questions.forEach((q) => {
    const fields = formQuestionFields(q)
    if (q.kind === "attachment") {
      // One upload decision drives both of its fields.
      const files = formRng() < 0.35 ? 0 : fInt(1, 4)
      row[fields[0].name] = files || null
      row[fields[1].name] = files > 0
      return
    }
    fields.forEach((f) => { row[f.name] = formAnswer(q, f, team) })
  })
}

FORMS.forEach((row) => fillFormSubmission(row, PROJECTS_BY_ID[row.projectId]))
PROJECTS.forEach((project, pi) => {
  const extra = fInt(2, 5)
  for (let i = 0; i < extra; i++) {
    const team: Row[] = project.teamIds.map((id: string) => PEOPLE_BY_ID[id])
    const row: Row = {
      id: `form-x${pi}-${i}`, projectId: project.id, accountId: project.accountId,
      "Template Name": fPick(FORM_TEMPLATES).name,
      "Submission Date": new Date(project["Start Date"].getTime() + formRng() * Math.max(0, TODAY.getTime() - project["Start Date"].getTime())),
      "Submitted By": fPick(team)["Team member name"],
      "Template Version Id": `v${fInt(1, 3)}`,
      "Answer Id": fInt(1000, 9999),
    }
    fillFormSubmission(row, project)
    FORMS.push(row)
  }
})

// ── Fields today's product reports on, filled in after everything else ─────────────
// Its own seeded generator, run last like the form answers, so these values shift no other
// module's numbers.
const auditRng = makeRng(20261029)
const aInt = (min: number, max: number) => Math.floor(auditRng() * (max - min + 1)) + min
const aPick = <T,>(arr: T[]): T => arr[aInt(0, arr.length - 1)]
const notAfterToday = (d: Date) => (d > TODAY ? TODAY : d)
const sumBy = (rows: Row[], key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0)

TIME_ENTRIES.forEach((e) => {
  const person = PEOPLE_BY_ID[e.userId]
  const approver = person["Timesheet approver"]
  const date: Date = e["Created date"]
  const createdAt = notAfterToday(addDays(date, aInt(0, 2)))
  const submittedOn = notAfterToday(addDays(createdAt, aInt(0, 4)))
  const decidedOn = notAfterToday(addDays(submittedOn, aInt(1, 4)))
  const approved = e["Approved Status"] === "Approved"
  const rejected = e["Approved Status"] === "Rejected"
  e["Notes"] = auditRng() < 0.4 ? aPick(["Client call", "Follow-up on review comments", "Pairing session", "Blocked on access", "Prep for demo"]) : ""
  e["Created by"] = auditRng() < 0.1 ? approver : person["Team member name"]
  e["Created at"] = createdAt
  e["Submitted by"] = person["Team member name"]
  e["Submitted on"] = submittedOn
  e["Approved by"] = approved ? approver : null
  e["Approved on"] = approved ? decidedOn : null
  e["Rejected by"] = rejected ? approver : null
  e["Rejected on"] = rejected ? decidedOn : null
  e["Last updated at"] = approved || rejected ? decidedOn : submittedOn
})

TASKS.forEach((t) => {
  const project = PROJECTS_BY_ID[t.projectId]
  const done = t["Status"] === "Completed"
  t["CSAT rating"] = done && auditRng() < 0.3 ? aInt(3, 5) : null
  t["Type"] = auditRng() < 0.12 ? "Milestone" : "Task"
  t["Description"] = `${t["Task name"]} for ${project["Project Name"]}`
  t["Created by"] = project["Project owner"]
  t["Created at"] = addDays(t["Start date"], -aInt(3, 20))
})

// Person columns that only restate who a record already points at — no draws, so nothing shifts.
PROJECTS.forEach((p) => { p["Created by"] = PEOPLE_BY_ID[p.createdById]?.["Team member name"] ?? null })
PHASES.forEach((ph) => { ph["Updated by"] = PROJECTS_BY_ID[ph.projectId]?.["Project owner"] ?? null })
TIME_ENTRIES.forEach((e) => { e["Team member"] = PEOPLE_BY_ID[e.userId]?.["Team member name"] ?? null })
EXPENSE.forEach((e) => { e["Expense owner"] = PEOPLE_BY_ID[e.userId]?.["Team member name"] ?? null })

ACTUAL_FINANCIALS.forEach((r) => {
  const entries = (TIME_BY_TASK[r.taskId] ?? []).filter((e) => {
    const d: Date = e["Created date"], m: Date = r["Recognised date"]
    return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth()
  })
  r["Tracked hours"] = Math.round(sumBy(entries, "Tracked Hours") / 60)
  r["Non-billable hours"] = Math.round(sumBy(entries, "Non Billable Hours") / 60)
  r["Cost rate"] = ROLES_BY_ID[r.roleId]["Cost rate"]
})

ESTIMATED_FINANCIALS.forEach((r) => {
  const task = TASKS_BY_ID[r.taskId]
  const billable = task["Billable"] ? Math.round(r["Allocated Hours"] * 0.85) : 0
  r["Billable allocated hours"] = billable
  r["Non-billable allocated hours"] = r["Allocated Hours"] - billable
  r["Estimated time cost"] = r["Estimated Cost"]
  r["Estimated expense cost"] = Math.round(sumBy(EXPENSE_BY_TASK[r.taskId] ?? [], "Amount") * (0.9 + auditRng() * 0.3))
  r["Cost rate"] = ROLES_BY_ID[r.roleId]["Cost rate"]
})

ALLOCATIONS.forEach((a) => {
  const project = PROJECTS_BY_ID[a.projectId]
  const start: Date = a["Allocation date"]
  a["Start date"] = start
  a["End date"] = new Date(Math.min(addDays(start, aInt(14, 60)).getTime(), project["Due Date"].getTime()))
  a["Allocation medium"] = aPick(["Hours per day", "Total hours", "% of capacity"])
})

DAILY_ROLLUP.forEach((r) => {
  const tracked = r["Allocated Hours"]
  const billable = Math.round(tracked * (0.6 + auditRng() * 0.3))
  r["Planned utilisation"] = aInt(60, 100)
  r["Soft allocated hours"] = Math.max(0, r["Allocated Hours"] - r["Hard Allocated Hours"])
  r["Tracked hours"] = tracked
  r["Billable hours"] = billable
  r["Non-billable hours"] = tracked - billable
})

ASSIGNEE_EFFORT.forEach((r) => {
  const task = TASKS_BY_ID[r.taskId]
  const project = PROJECTS_BY_ID[r.projectId]
  r["Created by"] = project["Project owner"]
  r["Created at"] = task["Created at"]
  r["Last updated by"] = auditRng() < 0.5 ? project["Project owner"] : PEOPLE_BY_ID[task.userId]["Team member name"]
  r["Last updated at"] = notAfterToday(addDays(task["Created at"], aInt(1, 40)))
})

FORMS.forEach((f) => {
  const edited = auditRng() < 0.35
  f["Last edited by"] = edited ? PEOPLE_BY_ID[PROJECTS_BY_ID[f.projectId].ownerId]["Team member name"] : f["Submitted By"]
  f["Last edited at"] = edited ? notAfterToday(addDays(f["Submission Date"], aInt(1, 20))) : f["Submission Date"]
})

BUDGETS.forEach((b) => {
  const project = PROJECTS_BY_ID[b.projectId]
  const tasks = TASKS_BY_PROJECT[b.projectId] ?? []
  const status = project["Project status"]
  const retainer = project["Billing type"] === "Retainer"
  const subStart: Date = project["Start Date"]
  const periodNo = Math.max(1, Math.min(12, Math.floor((TODAY.getTime() - subStart.getTime()) / (30 * 86400000)) + 1))
  const periodStart = addDays(subStart, (periodNo - 1) * 30)
  const periodEntries = tasks.flatMap((t) => TIME_BY_TASK[t.id] ?? []).filter((e) => e["Created date"] >= periodStart)
  b["Status"] = status === "Completed" || status === "Cancelled" ? "Completed" : status === "Not Started" ? "Proposed" : "Active"
  b["Actual time cost"] = b["Budget Actual Cost"]
  b["Estimated time cost"] = b["Budget Estimated Cost"]
  b["Actual expense cost"] = tasks.reduce((s, t) => s + sumBy(EXPENSE_BY_TASK[t.id] ?? [], "Amount"), 0)
  b["Estimated expense cost"] = Math.round(b["Actual expense cost"] * (1 + auditRng() * 0.25))
  b["Subscription frequency"] = retainer ? "Monthly" : null
  b["No. of periods"] = retainer ? 12 : null
  b["Subscription start"] = retainer ? subStart : null
  b["Current period no."] = retainer ? periodNo : null
  b["Current period start"] = retainer ? periodStart : null
  b["Current period end"] = retainer ? addDays(periodStart, 29) : null
  b["Current period revenue"] = retainer ? sumBy(periodEntries, "Actual Revenue") : null
  b["Current period budget"] = retainer ? Math.round(b["Project Budget"] / 12) : null
  b["Current period tracked time"] = retainer ? Math.round(sumBy(periodEntries, "Tracked Hours") / 60) : null
  b["Created at"] = addDays(subStart, -aInt(5, 30))
  b["Last updated at"] = notAfterToday(addDays(TODAY, -aInt(0, 45)))
})

PROJECTS.forEach((p) => {
  const budget = BUDGET_BY_PROJECT[p.id]
  const status = p["Project status"]
  const started = status !== "Not Started"
  const start: Date = p["Start Date"], due: Date = p["Due Date"]
  const budgetedHours = budget["Budgeted Hours"]
  const trackedHours = Math.round(budget["Budget Tracked Minutes"] / 60)
  const estCost = budget["Budget Estimated Cost"]
  const allocs = ALLOCATIONS.filter((a) => a.projectId === p.id)
  const inProgressPhases = (PHASES_BY_PROJECT[p.id] ?? []).filter((ph) => ph["Phase status"] === "In Progress").map((ph) => ph["Project phase"])
  const late = status !== "Completed" && due < TODAY
  p["Actual start date"] = started ? addDays(start, aInt(0, 10)) : null
  p["Actual end date"] = status === "Completed" ? addDays(due, aInt(-10, 25)) : null
  p["Inferred progress"] = status === "Completed" ? "Completed" : late ? "Delayed" : p["Progress Percent"] < 30 && due < addDays(TODAY, 30) ? "At risk" : "On track"
  p["Last status update"] = started ? notAfterToday(addDays(TODAY, -aInt(0, 30))) : null
  p["Project age"] = Math.max(0, Math.round((TODAY.getTime() - start.getTime()) / 86400000))
  p["CSAT rating"] = status === "Completed" || auditRng() < 0.5 ? Math.round((3 + auditRng() * 2) * 10) / 10 : null
  p["Last milestone CSAT"] = p["CSAT rating"] == null ? null : aInt(3, 5)
  p["Budgeted hours"] = budgetedHours
  p["% budgeted hours consumed"] = budgetedHours > 0 ? Math.round((trackedHours / budgetedHours) * 100) : 0
  p["Remaining hours"] = Math.max(0, budgetedHours - trackedHours)
  p["Estimated cost"] = estCost
  p["Actual margin"] = p["Project Revenue"] > 0 ? Math.round((p["Project Profit"] / p["Project Revenue"]) * 100) : 0
  p["Actual time cost"] = budget["Actual time cost"]
  p["Estimated time cost"] = budget["Estimated time cost"]
  p["Actual expense cost"] = budget["Actual expense cost"]
  p["Estimated expense cost"] = budget["Estimated expense cost"]
  p["Template"] = aPick(["Standard Onboarding", "Enterprise Implementation", "Quick Start", "Migration Playbook"])
  p["Partners"] = auditRng() < 0.4 ? [aPick(["Deloitte", "Accenture", "Slalom", "Thoughtworks"])] : []
  p["Current phases"] = inProgressPhases
  p["Total recognised revenue"] = p["Project Revenue"]
  p["Customer members invited"] = aInt(2, 12)
  p["Customer members accepted"] = Math.max(0, p["Customer members invited"] - aInt(0, 3))
  p["Last allocation date"] = allocs.reduce<Date | null>((m, a) => (!m || a["End date"] > m ? a["End date"] : m), null)
  p["Created at"] = addDays(start, -aInt(7, 40))
  p["Last updated at"] = notAfterToday(addDays(TODAY, -aInt(0, 20)))
})

const MODULE_ROWS: Record<string, Row[]> = {
  // Each template's submissions are that template's rows.
  ...Object.fromEntries(FORM_TEMPLATES.map((t) => [t.name, FORMS.filter((r) => r["Template Name"] === t.name)])),
  "Account": ACCOUNTS,
  "Role": ROLES,
  "People": PEOPLE,
  "Project": PROJECTS,
  "Phase": PHASES,
  "Task": TASKS,
  "Budget": BUDGETS,
  "Invoice": INVOICES,
  "Time tracking": TIME_ENTRIES,
  "Allocations": ALLOCATIONS,
  "Assignee effort": ASSIGNEE_EFFORT,
  "Actual financials": ACTUAL_FINANCIALS,
  "Estimated financials": ESTIMATED_FINANCIALS,
  "Expense": EXPENSE,
  "Capacity": CAPACITY,
  "Leave & holiday": LEAVE_HOLIDAY,
  "Project members": PROJECT_MEMBERS,
  "Daily rollup": DAILY_ROLLUP,
  "Epic": EPIC,
  "Sprint": SPRINT,
  "Forms": FORMS,
  "Meeting": MEETING,
  "Revenue entries": REVENUE_ENTRIES,
}

// Backfill a `budgetId` onto every row that has a `projectId`, now that Budgets exist —
// closes the Project→Budget→Revenue-entries hop for any grain finer than Budget.
Object.values(MODULE_ROWS).forEach((rows) => {
  rows.forEach((row) => {
    if (row.budgetId == null && row.projectId != null) row.budgetId = BUDGET_BY_PROJECT[row.projectId]?.id ?? null
  })
})

// The sample data above is generated under the older field names, so its rows are renamed to the
// final names once, after every generator and backfill has run.
Object.entries(FIELD_RENAMES).forEach(([key, next]) => {
  const i = key.indexOf("::"), mod = key.slice(0, i), old = key.slice(i + 2)
  ;(MODULE_ROWS[mod] ?? []).forEach((row) => {
    if (old in row) { row[next] = row[old]; delete row[old] }
  })
})

// Grain rank — higher = finer (more rows per ancestor). The report's base fact table is
// whichever used module has the highest rank; everything coarser is looked up as a
// dimension, everything else at the same rank is rolled up as a sibling collection.
const MODULE_RANK: Record<string, number> = {
  Account: 0, Role: 0, People: 0,
  Project: 1, Budget: 1, Invoice: 1, "Revenue entries": 1,
  Phase: 2, Capacity: 2, "Leave & holiday": 2, "Project members": 2, Epic: 2, Sprint: 2, Forms: 2, Meeting: 2, "Daily rollup": 2,
  Task: 3, Allocations: 3, "Assignee effort": 3, "Actual financials": 3, "Estimated financials": 3, Expense: 3,
  "Time tracking": 4,
}
const GRAIN_PRIORITY = [
  "Time tracking", "Task", "Assignee effort", "Allocations", "Actual financials", "Estimated financials", "Expense",
  "Phase", "Capacity", "Leave & holiday", "Project members", "Daily rollup", "Epic", "Sprint", "Forms", "Meeting",
  "Project", "Budget", "Invoice", "Revenue entries",
  "Role", "People", "Account",
]

// Dimension modules: every finer row carries a single FK id that resolves to exactly one
// dimension row — a plain O(1) lookup, never a rollup. Budget/Invoice are simplified to
// exactly one row per project, so they're keyed by "projectId" rather than their own id.
const DIMENSION_ID_KEY: Record<string, string> = {
  Account: "accountId", Role: "roleId", People: "userId", Project: "projectId",
  Phase: "phaseId", Task: "taskId", Budget: "projectId", Invoice: "projectId",
}
// Where a module pair is reachable by more than one relationship, the role chosen on the chip
// decides which foreign key on the grain row gets followed. A pair with no entry here resolves
// the same way whichever role is picked — the relationship exists in the schema but the mock
// data carries only one key for it.
// Team member roles are resolved through PERSON_ROLES (personsForRow); this map is for the other
// module pairs that can be reached more than one way.
const ROLE_FK: Record<string, string> = {}

// A one-to-many role on the report's own record cannot be answered by swapping a key — a project
// has many members, so there is no single person to put in the cell. The role raises the
// report's grain to the junction that already models the pairing, giving one row per
// project-and-member, which is what "group by project member" actually means. The same role
// reached through a PARENT (a task's project's members) instead puts each record under every
// person it names, and totals count the record once.
const ROLE_GRAIN: Record<string, string> = {
  "Project|People|Project · Project members": "Project members",
}
const roleFkKey = (grain: string, target: string, role: string) => `${grain}|${target}|${role}`

const PEOPLE_BY_NAME: Record<string, Row> = Object.fromEntries(PEOPLE.map((p) => [p["Team member name"], p]))

// The person (or people) a record names in this role. An array for a one-to-many role.
function personsForRow(grainModule: string, row: Row, role: PersonRole): Row | Row[] | undefined {
  // The junction a one-to-many role raised the report to: each row already is one member.
  if (ROLE_GRAIN[roleFkKey(role.module, "People", role.id)] === grainModule) return PEOPLE_BY_ID[row.userId]
  const via = role.module === grainModule
    ? row
    : DIMENSION_BY_ID[role.module]?.[row[DIMENSION_ID_KEY[role.module]]]
  if (!via) return undefined
  if (role.idsKey) return (Array.isArray(via[role.idsKey]) ? via[role.idsKey] : []).map((id: string) => PEOPLE_BY_ID[id]).filter(Boolean)
  if (role.idKey) return PEOPLE_BY_ID[via[role.idKey]]
  if (role.nameKey) return via[role.nameKey] ? PEOPLE_BY_NAME[via[role.nameKey]] : undefined
  return undefined
}

const DIMENSION_BY_ID: Record<string, Record<string, Row>> = {
  Account: ACCOUNTS_BY_ID, Role: ROLES_BY_ID, People: PEOPLE_BY_ID, Project: PROJECTS_BY_ID,
  Phase: PHASES_BY_ID, Task: TASKS_BY_ID, Budget: BUDGET_BY_PROJECT, Invoice: INVOICE_BY_PROJECT,
}

// Rollup-collection modules: one-to-many relative to whichever row asks for them.
// Resolved by matching this FK against the asking row's own id (if the asking row *is*
// that ancestor) or its own copy of the same FK (if it merely carries it).
const ROLLUP_FK: Record<string, string> = {
  "Time tracking": "taskId", "Allocations": "taskId", "Assignee effort": "taskId",
  "Actual financials": "taskId", "Estimated financials": "taskId", "Expense": "taskId",
  "Capacity": "userId", "Leave & holiday": "userId",
  "Project members": "projectId", "Daily rollup": "projectId", "Epic": "projectId",
  "Sprint": "projectId", "Forms": "projectId",
  "Meeting": "accountId",
  "Revenue entries": "budgetId",
}
const MODULE_OWN_ID_KEY: Record<string, string> = {
  Task: "taskId", Project: "projectId", People: "userId", Account: "accountId", Budget: "budgetId", Phase: "phaseId",
}
// Rollup-collection modules with a genuine per-row date column — the only ones a
// per-value timeline filter can meaningfully narrow (Allocations/Actual financials/
// Estimated financials have no date column in the real schema, so their picker is
// display-only, matching the schema honestly rather than inventing a date for them).
const ROLLUP_DATE_FIELD: Record<string, string> = {
  "Time tracking": "Created date",
  "Leave & holiday": "Date",
  "Allocations": "Allocation date",
  "Actual financials": "Recognised date",
  "Estimated financials": "Planned date",
}

const ROLLUP_INDEX: Record<string, Map<string, Row[]>> = {}
Object.keys(ROLLUP_FK).forEach((mod) => {
  const fk = ROLLUP_FK[mod]
  const idx = new Map<string, Row[]>()
  ;(MODULE_ROWS[mod] ?? []).forEach((row) => {
    const key = row[fk]
    if (key == null) return
    if (!idx.has(key)) idx.set(key, [])
    idx.get(key)!.push(row)
  })
  ROLLUP_INDEX[mod] = idx
})

function rollupOne(rows: Row[], field: string, type: FieldType): any {
  if (rows.length === 0) return undefined
  if (isNumericType(type)) {
    const nums = rows.map((r) => Number(r[field])).filter((n) => !Number.isNaN(n))
    if (nums.length === 0) return undefined
    if (type === "percent") return nums.reduce((a, b) => a + b, 0) / nums.length
    return nums.reduce((a, b) => a + b, 0)
  }
  return rows[0][field]
}

// The instants a time-tracked metric is narrowed to: a chip's calendar, one Timeline column's
// period, or the Timeline filter. The filter is an ordinary date filter, so it can pick scattered
// values ("Jan 2026, Mar 2026", or every January) — hence a test rather than a span.
type DateWindow = (t: number) => boolean
const spanWindow = ([lo, hi]: [number, number]): DateWindow => (t) => t >= lo && t <= hi

function withinWindow(v: any, window: DateWindow): boolean {
  if (v == null) return false
  return window(v instanceof Date ? v.getTime() : new Date(v).getTime())
}

// Resolves a "Module::Field" key against a row at any grain — own field, ancestor
// dimension, or rollup-collection — using the FK ids every generated row carries.
function resolveFieldForRow(grainModule: string, row: Row, targetKey: string, dateWindow: DateWindow | null, role?: string): any {
  if (isFormulaKey(targetKey)) {
    // A table row is one record: the formula over that record's own values (children totalled).
    const def = formulaOf(targetKey)
    if (!def) return undefined
    const n = formulaNumber(def, formulaEnvForRow(def, grainModule, row))
    return Number.isNaN(n) ? undefined : Math.round(n * 100) / 100
  }
  const targetModule = fieldKeyModule(targetKey)
  const targetField = fieldDisplayName(targetKey)
  if (targetModule === grainModule) {
    // Own-field fast path still has to respect an active per-value timeline window —
    // a row outside it should drop out of the aggregate, not just get returned as-is.
    if (dateWindow) {
      const ownDateField = ROLLUP_DATE_FIELD[targetModule]
      if (ownDateField && !withinWindow(row[ownDateField], dateWindow)) return undefined
    }
    return row[targetField]
  }
  const personRole = targetModule === "People" ? PERSON_ROLES[normalizeRoleId(role) ?? ""] : undefined
  if (personRole) {
    const p = personsForRow(grainModule, row, personRole)
    if (Array.isArray(p)) return p.map((x) => x[targetField])
    return p ? p[targetField] : undefined
  }
  const dimKey = (role ? ROLE_FK[roleFkKey(grainModule, targetModule, role)] : undefined)
    ?? DIMENSION_ID_KEY[targetModule]
  if (dimKey) {
    const id = row[dimKey]
    const dimRow = id != null ? DIMENSION_BY_ID[targetModule][id] : undefined
    return dimRow ? dimRow[targetField] : undefined
  }
  const fk = ROLLUP_FK[targetModule]
  if (!fk) return undefined
  const matchId = MODULE_OWN_ID_KEY[grainModule] === fk ? row.id : row[fk]
  let matching = matchId != null ? (ROLLUP_INDEX[targetModule]?.get(matchId) ?? []) : []
  const dateField = ROLLUP_DATE_FIELD[targetModule]
  if (dateWindow && dateField) matching = matching.filter((r) => withinWindow(r[dateField], dateWindow))
  return rollupOne(matching, targetField, getFieldType(targetKey))
}

// Resolves the single Project currency shared by every row across the given cell buckets, or
// null if they span more than one currency (or none carry one) — backs the "View table values
// in project's currency" report setting. Folding to null on any disagreement, rather than
// picking the first one found, matters because a subtotal/grand-total bucket can span several
// projects; showing a single code there would misrepresent a mixed-currency total as if it were
// one currency.
function resolveGroupCurrency(buckets: Row[][], grainModule: string): string | null {
  let result: string | null = null
  for (const bucket of buckets) {
    for (const row of bucket) {
      const c = resolveFieldForRow(grainModule, row, "Project::Project currency", null)
      if (c == null || c === "") continue
      if (result === null) result = String(c)
      else if (result !== String(c)) return null
    }
  }
  return result
}

// ── Grain selection ───────────────────────────────────────────────────────────────
// The grain implied purely by which fields are in play. This is what the chips ask about, so
// it must not itself depend on the roles they have chosen — otherwise picking a role could
// change which roles are on offer.
// A formula in Values stands in for the fields it is made of when the report decides its records
// and checks splits. Each letter becomes a stand-in value whose id is "<formula chip id>#<letter>".
function expandFormulaValues(fields: PivotFields): PivotFields {
  if (!fields.values.some((v) => isFormulaKey(v.field))) return fields
  return {
    ...fields,
    values: fields.values.flatMap((v) => {
      if (!isFormulaKey(v.field)) return [v]
      const def = formulaOf(v.field)
      return def ? def.refs.map((r) => ({ id: `${v.id}#${r.letter}`, field: r.field })) : []
    }),
  }
}
const FORMULA_VALUES_ONLY = "Formula fields can only go in Values"

// Which record of a module a report row stands for — used to count a per-record date formula once.
function ownerIdAt(grainModule: string, row: Row, mod: string): any {
  if (mod === grainModule) return row.id
  const dimKey = DIMENSION_ID_KEY[mod]
  if (dimKey) return row[dimKey]
  const fk = ROLLUP_FK[mod]
  if (fk) return MODULE_OWN_ID_KEY[grainModule] === fk ? row.id : row[fk]
  return row.id
}
function formulaEnvForRow(def: FormulaDef, grainModule: string, row: Row): Record<string, FVal> {
  const env: Record<string, FVal> = {}
  def.refs.forEach((r) => {
    const raw = resolveFieldForRow(grainModule, row, r.field, null)
    if (getFieldType(r.field) === "date") env[r.letter] = toDay(raw)
    else { const n = Number(raw); env[r.letter] = raw == null || raw === "" || Number.isNaN(n) ? null : n }
  })
  return env
}
/** A formula over a set of report rows: each letter's field totalled over them, then the formula
    (so a total is sum(A)/sum(B)). A formula on dates is worked out per record and then summed. */
function formulaOverRows(def: FormulaDef, rows: Row[], grainModule: string): number {
  if (formulaHasDates(def)) {
    const seen = new Set<string>()
    let any = false, sum = 0
    rows.forEach((row) => {
      const key = def.refs.map((r) => String(ownerIdAt(grainModule, row, fieldKeyModule(r.field)))).join("|")
      if (seen.has(key)) return
      seen.add(key)
      const n = formulaNumber(def, formulaEnvForRow(def, grainModule, row))
      if (!Number.isNaN(n)) { any = true; sum += n }
    })
    return any ? Math.round(sum * 100) / 100 : NaN
  }
  const env: Record<string, FVal> = {}
  def.refs.forEach((r) => {
    env[r.letter] = rows.length === 0 ? null
      : aggregateBucket(rows, grainModule, { id: `${def.id}#${r.letter}`, field: r.field }, "Sum", getFieldType(r.field))
  })
  const n = formulaNumber(def, env)
  return Number.isNaN(n) ? NaN : Math.round(n * 100) / 100
}

function pickGrain(source: string, fields: PivotFields, filterRules: FilterRule[], extra?: Set<string>): string {
  // A form submission belongs to one task, project, account and submitter, so everything a
  // template report reaches is a lookup from the submission: the records stay the submissions.
  if (isFormTemplateSource(source)) return source
  const used = new Set<string>(extra)
  const reachable = new Set(SOURCE_MODULES[source] ?? [source])
  ;[...fields.columns, ...fields.rows].forEach((item) => used.add(fieldKeyModule(item.field)))
  filterRules.forEach((r) => used.add(fieldKeyModule(r.field)))
  // Numbers from two tables that sit side by side (hours and expenses, both per task) are each
  // totalled from their own records, one level up — at the record of either table, every
  // record of the other would be brought in again. Nothing splits by either table's own fields
  // here; if something did, the report would have to be at that table's records.
  const valueMods = [...new Set(expandFormulaValues(fields).values.map((item) => fieldKeyModule(item.field)))]
  const siblings = valueMods.filter((m) => reachable.has(m) && ROLLUP_FK[m] && !used.has(m))
  const parentOf = (m: string) => Object.keys(MODULE_OWN_ID_KEY).find((k) => MODULE_OWN_ID_KEY[k] === ROLLUP_FK[m])
  if (siblings.length >= 2) {
    siblings.forEach((m) => { const p = parentOf(m); if (p) { used.add(p); reachable.add(p) } })
    valueMods.filter((m) => !siblings.includes(m)).forEach((m) => used.add(m))
  } else {
    valueMods.forEach((m) => used.add(m))
  }
  let best = source
  let bestRank = MODULE_RANK[source] ?? 0
  used.forEach((m) => {
    if (!reachable.has(m) || !MODULE_ROWS[m]) return
    const rank = MODULE_RANK[m] ?? 0
    if (rank > bestRank) { best = m; bestRank = rank }
    else if (rank === bestRank) {
      const mi = GRAIN_PRIORITY.indexOf(m), bi = GRAIN_PRIORITY.indexOf(best)
      if (mi !== -1 && (bi === -1 || mi < bi)) best = m
    }
  })
  return best
}

// Every chip's concrete role, decided against the base grain and then carried. Deciding once
// matters: choosing "Project member" raises the grain to the junction, and a role re-derived at
// that point would no longer see the choices the user was actually offered.
function resolveChipRoles(
  baseGrain: string, fields: PivotFields, lookupPaths: Record<string, string>, source?: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  ;[...fields.columns, ...fields.rows, ...fields.values].forEach((item) => {
    const role = effectiveLookupPath(baseGrain, item.field, lookupPaths[item.id], source)
    if (role) out[item.id] = role
  })
  return out
}

// The grain the data is actually computed at: the base grain, plus any junction module that a
// chosen role pulls in. Two passes rather than one, so the roles are read against a stable base.
function pickGrainWithRoles(
  source: string, fields: PivotFields, filterRules: FilterRule[], lookupPaths: Record<string, string>,
): string {
  const base = pickGrain(source, fields, filterRules)
  const roles = resolveChipRoles(base, fields, lookupPaths, source)
  const implied = new Set<string>()
  ;[...fields.columns, ...fields.rows, ...fields.values].forEach((item) => {
    const role = roles[item.id]
    if (!role) return
    const g = ROLE_GRAIN[roleFkKey(base, fieldKeyModule(item.field), role)]
    if (g && MODULE_ROWS[g]) implied.add(g)
  })
  return implied.size === 0 ? base : pickGrain(source, fields, filterRules, implied)
}

// ── Splitting a number (drop-time check) ──────────────────────────────────────────
// A number can only be split by things above it. Each record of the number's own table must
// land under exactly one row or column; if it lands under several (one invoice, several people
// who logged time to it), every one of them shows the full amount and the rows add up to more
// than the total. Filters never copy a number, and reports with no numbers have nothing to
// split, so only Rows/Columns × numeric Values are checked.
const SPLIT_OWNER_NOUN: Record<string, string> = {
  Account: "account", Role: "role", People: "person", Project: "project", Phase: "phase", Task: "task",
  Budget: "budget", Invoice: "invoice",
}

interface SplitConflict { valueId: string; splitId: string; message: string }

// "Amount" alone could be an invoice's or an expense's, so the number is named with its table.
function splitValueName(key: string): string {
  const mod = fieldKeyModule(key), name = fieldDisplayName(key)
  return name.toLowerCase().includes(mod.toLowerCase()) ? name : `${mod} ${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

function splitConflicts(
  source: string, fields: PivotFields, filterRules: FilterRule[], lookupPaths: Record<string, string>,
): SplitConflict[] {
  if (isFormTemplateSource(source)) return []
  const grain = pickGrainWithRoles(source, fields, filterRules, lookupPaths)
  const roles = resolveChipRoles(pickGrain(source, fields, filterRules), fields, lookupPaths, source)
  const rows = MODULE_ROWS[grain] ?? []
  const splits = [...fields.rows, ...fields.columns].filter((s) => s.field !== TIMELINE_KEY)
  const out: SplitConflict[] = []
  // A formula splits like the fields it is made of: it can go under a row only if every one of
  // its letters can, and the message names the formula.
  for (const v of expandFormulaValues(fields).values) {
    const ownerId = v.id.split("#")[0]
    const shownKey = fields.values.find((it) => it.id === ownerId)?.field ?? v.field
    const m = fieldKeyModule(v.field)
    if (m === grain || !isNumericType(getFieldType(v.field))) continue
    // Which record of the number's table each report row stands for: a looked-up parent's id,
    // or the key a rolled-up collection hangs off.
    let owner: (r: Row) => any
    let noun: string
    const dimKey = (roles[v.id] ? ROLE_FK[roleFkKey(grain, m, roles[v.id])] : undefined) ?? DIMENSION_ID_KEY[m]
    const personRole = m === "People" ? PERSON_ROLES[roles[v.id] ?? ""] : undefined
    if (personRole) {
      owner = (r) => {
        const p = personsForRow(grain, r, personRole)
        return Array.isArray(p) ? (p.length ? p.map((x) => x.id).join(",") : undefined) : p?.id
      }
      noun = "person"
    } else if (dimKey) {
      owner = (r) => r[dimKey]
      noun = SPLIT_OWNER_NOUN[m] ?? m.toLowerCase()
    } else if (ROLLUP_FK[m]) {
      const fk = ROLLUP_FK[m]
      owner = MODULE_OWN_ID_KEY[grain] === fk ? (r) => r.id : (r) => r[fk]
      const ownerModule = Object.keys(MODULE_OWN_ID_KEY).find((k) => MODULE_OWN_ID_KEY[k] === fk)
      noun = ownerModule ? SPLIT_OWNER_NOUN[ownerModule] ?? ownerModule.toLowerCase() : "record"
    } else continue
    for (const s of splits) {
      if (fieldKeyModule(s.field) === m) continue
      const seen = new Map<any, string>()
      const clash = rows.some((r) => {
        const id = owner(r)
        if (id == null) return false
        const label = JSON.stringify(resolveFieldForRow(grain, r, s.field, null, roles[s.id]) ?? null)
        const prev = seen.get(id)
        if (prev === undefined) { seen.set(id, label); return false }
        return prev !== label
      })
      if (clash && !out.some((c) => c.valueId === ownerId && c.splitId === s.id)) {
        out.push({
          valueId: ownerId, splitId: s.id,
          message: `${isFormulaKey(shownKey) ? fieldDisplayName(shownKey) : splitValueName(v.field)} can't be split by ${fieldDisplayName(s.field)}: one ${noun} has several`,
        })
      }
    }
  }
  return out
}

// The reason a field can't go where it's headed, or null. Only clashes the move itself creates
// count, so an unrelated drop is never blocked by something already on the shelves.
const PENDING_ITEM_ID = "pending-drop"
function pivotDropBlockReason(
  source: string, fields: PivotFields, filterRules: FilterRule[], lookupPaths: Record<string, string>,
  zone: PivotZoneKey, field: string, id?: string,
): string | null {
  if (field === TIMELINE_KEY) return null
  if (isFormulaKey(field) && zone !== "values") return FORMULA_VALUES_ONLY
  const itemId = id ?? PENDING_ITEM_ID
  const without = (arr: PivotItem[]) => arr.filter((it) => it.id !== itemId)
  const next: PivotFields = { columns: without(fields.columns), rows: without(fields.rows), values: without(fields.values) }
  next[zone] = [...next[zone], { id: itemId, field }]
  const hit = splitConflicts(source, next, filterRules, lookupPaths)
    .find((c) => c.valueId === itemId || c.splitId === itemId)
  return hit?.message ?? null
}

// What is being dragged right now. A drop zone can't read the drag payload until the drop, but it
// has to say "no" while the pointer is still over it.
let activeDrag: { field: string; id?: string } | null = null
const dropReasonCache = new Map<string, string | null>()
function startDrag(field: string, id?: string) { activeDrag = { field, id }; dropReasonCache.clear() }
function endDrag() { activeDrag = null; dropReasonCache.clear() }

// ── Date bucketing / relative windows (shared by row & column grouping, and filters) ──
function quarterOf(d: Date): number { return Math.floor(d.getMonth() / 3) + 1 }
function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3) / 7)
}
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function bucketDateLabel(d: Date, granularity: string): string {
  const year = d.getFullYear()
  switch (granularity) {
    case "Year": return String(year)
    case "Quarter & Year": return `Q${quarterOf(d)} ${year}`
    case "Quarter": return `Q${quarterOf(d)}`
    case "Month & Year": return `${MONTH_SHORT[d.getMonth()]} ${year}`
    case "Month": return MONTH_NAMES[d.getMonth()]
    case "Week & Year": return `W${isoWeekNumber(d)} ${year}`
    case "Week": return `Week ${isoWeekNumber(d)}`
    case "Date & Time": return `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, "0")}:00`
    default: return d.toISOString().slice(0, 10) // "Date"
  }
}

function startOfQuarter(d: Date): Date { return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1) }
function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7 // Mon=0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
}

function relativeWindow(granularity: string, opt: string, n: number, today: Date): [Date, Date] | null {
  const isN = isNInput(opt)
  const dir = opt.startsWith("Next") ? 1 : -1
  if (granularity === "Year") {
    if (opt === "This year") return [new Date(today.getFullYear(), 0, 1), new Date(today.getFullYear(), 11, 31, 23, 59, 59)]
    if (opt === "Year to date") return [new Date(today.getFullYear(), 0, 1), today]
    if (opt === "Last year") return [new Date(today.getFullYear() - 1, 0, 1), new Date(today.getFullYear() - 1, 11, 31, 23, 59, 59)]
    if (opt === "Next year") return [new Date(today.getFullYear() + 1, 0, 1), new Date(today.getFullYear() + 1, 11, 31, 23, 59, 59)]
    if (isN) return dir < 0 ? [new Date(today.getFullYear() - n, today.getMonth(), today.getDate()), today] : [today, new Date(today.getFullYear() + n, today.getMonth(), today.getDate())]
  }
  if (granularity.startsWith("Quarter")) {
    const qStart = startOfQuarter(today)
    const qEnd = addDays(new Date(qStart.getFullYear(), qStart.getMonth() + 3, 1), -1)
    if (opt.startsWith("This")) return [qStart, qEnd]
    if (opt === "Last quarter") { const s = new Date(qStart.getFullYear(), qStart.getMonth() - 3, 1); return [s, addDays(qStart, -1)] }
    if (opt === "Next quarter") { const s = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 1); return [s, addDays(new Date(s.getFullYear(), s.getMonth() + 3, 1), -1)] }
    if (isN) { const months = n * 3; return dir < 0 ? [new Date(qStart.getFullYear(), qStart.getMonth() - months, 1), today] : [today, new Date(qStart.getFullYear(), qStart.getMonth() + months, 1)] }
  }
  if (granularity.startsWith("Month")) {
    const mStart = new Date(today.getFullYear(), today.getMonth(), 1)
    if (opt.startsWith("This")) return [mStart, new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59)]
    if (opt === "Last month") { const s = new Date(today.getFullYear(), today.getMonth() - 1, 1); return [s, addDays(mStart, -1)] }
    if (opt === "Next month") { const s = new Date(today.getFullYear(), today.getMonth() + 1, 1); return [s, new Date(s.getFullYear(), s.getMonth() + 1, 0, 23, 59, 59)] }
    if (isN) return dir < 0 ? [new Date(today.getFullYear(), today.getMonth() - n, 1), today] : [today, new Date(today.getFullYear(), today.getMonth() + n, 1)]
  }
  if (granularity.startsWith("Week")) {
    const wStart = startOfWeek(today)
    if (opt.startsWith("This")) return [wStart, addDays(wStart, 6)]
    if (opt === "Last week") return [addDays(wStart, -7), addDays(wStart, -1)]
    if (opt === "Next week") return [addDays(wStart, 7), addDays(wStart, 13)]
    if (isN) return dir < 0 ? [addDays(wStart, -7 * n), today] : [today, addDays(wStart, 7 * n)]
  }
  if (granularity.startsWith("Date")) {
    if (opt === "Today" || opt === "Now") return [new Date(today.getFullYear(), today.getMonth(), today.getDate()), new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59)]
    if (opt === "Yesterday") { const y = addDays(today, -1); return [new Date(y.getFullYear(), y.getMonth(), y.getDate()), new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59)] }
    if (opt === "Tomorrow") { const t = addDays(today, 1); return [new Date(t.getFullYear(), t.getMonth(), t.getDate()), new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59)] }
    if (opt === "Day to date") return [new Date(today.getFullYear(), today.getMonth(), today.getDate()), today]
    if (isN) return dir < 0 ? [addDays(today, -n), today] : [today, addDays(today, n)]
  }
  return null
}

// The per-value timeline picker's own flat preset list (DATE_PRESETS) — distinct from
// the granularity-scoped RELATIVE_OPTIONS used by the Filters bar's date modal.
function presetWindow(period: string, today: Date): [Date, Date] | null {
  switch (period) {
    case "This week": return [startOfWeek(today), addDays(startOfWeek(today), 6)]
    case "Last week": return [addDays(startOfWeek(today), -7), addDays(startOfWeek(today), -1)]
    case "This month": return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59)]
    case "Last month": return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59)]
    case "This quarter": { const s = startOfQuarter(today); return [s, addDays(new Date(s.getFullYear(), s.getMonth() + 3, 1), -1)] }
    case "Last quarter": { const s = startOfQuarter(today); return [new Date(s.getFullYear(), s.getMonth() - 3, 1), addDays(s, -1)] }
    case "Last 90 days": return [addDays(today, -90), today]
    case "This year": return [new Date(today.getFullYear(), 0, 1), new Date(today.getFullYear(), 11, 31, 23, 59, 59)]
    case "Year to date": return [new Date(today.getFullYear(), 0, 1), today]
    case "Last 12 months": return [addDays(today, -365), today]
    default: return null
  }
}

// ── Timeline ────────────────────────────────────────────────────────────────────
// A date that belongs to no module. Every time-tracked metric already has its own date — hours
// when logged, allocations when booked, revenue when recognised — and the Timeline lines them up
// on one calendar. It only ever acts on those metrics: it never filters rows, and it never
// touches a measure with no date of its own (a project's budget, say).
const TIMELINE_GRANULARITIES = ["Week & Year", "Month & Year", "Quarter & Year", "Year"]
// Weekly columns over a couple of years would be unreadable; past this the latest are shown.
const TIMELINE_MAX_PERIODS = 24

// Has the date filter been given anything to filter by? An untouched one passes every date.
function dateRuleIsSet(rule: FilterRule): boolean {
  const mode = rule.dateMode ?? "actual"
  if (mode === "actual") return (rule.values ?? []).length > 0
  if (mode === "range") return !!rule.dateFrom || (rule.dateRangeOp === "between" && !!rule.dateTo)
  return !!rule.dateRelativeOpt
    && !!relativeWindow(rule.dateGranularity || "Month & Year", rule.dateRelativeOpt, rule.dateRelativeN || 1, TODAY)
}

// The Timeline filter reads exactly like a filter on any date field — same modes, same matching.
function timelineRuleWindow(rule: FilterRule | undefined): DateWindow | null {
  if (!rule || !dateRuleIsSet(rule)) return null
  return (t) => dateRuleMatches(new Date(t), rule)
}

// The report's Timeline filter and a viewer's one together: the viewer narrows within the
// report's period, never beyond it — the same order base and view filters run in everywhere.
function combinedTimelineWindow(baseRules: FilterRule[], viewRules: FilterRule[]): DateWindow | null {
  return intersectWindows(
    timelineRuleWindow(baseRules.find((r) => r.field === TIMELINE_KEY)),
    timelineRuleWindow(viewRules.find((r) => r.field === TIMELINE_KEY)),
  )
}

// A metric chip's own calendar as a window — the same reading aggregateBucket applies, kept in
// one place so the Timeline and the chip calendar can never disagree about what "This month" is.
function metricFilterWindow(f: MetricFilter | undefined): DateWindow | null {
  if (!f?.period) return null
  if (f.period === "custom") {
    if (!f.customFrom || !f.customTo) return null
    return spanWindow([new Date(f.customFrom).getTime(), new Date(f.customTo).getTime()])
  }
  const w = presetWindow(f.period, TODAY)
  return w ? spanWindow([w[0].getTime(), w[1].getTime()]) : null
}

function intersectWindows(a: DateWindow | null, b: DateWindow | null): DateWindow | null {
  if (!a) return b
  if (!b) return a
  return (t) => a(t) && b(t)
}

function periodStart(d: Date, gran: string): Date {
  switch (gran) {
    case "Year": return new Date(d.getFullYear(), 0, 1)
    case "Quarter & Year": return startOfQuarter(d)
    case "Week & Year": return startOfWeek(d)
    default: return new Date(d.getFullYear(), d.getMonth(), 1)
  }
}
function nextPeriodStart(d: Date, gran: string): Date {
  switch (gran) {
    case "Year": return new Date(d.getFullYear() + 1, 0, 1)
    case "Quarter & Year": return new Date(d.getFullYear(), d.getMonth() + 3, 1)
    case "Week & Year": return addDays(d, 7)
    default: return new Date(d.getFullYear(), d.getMonth() + 1, 1)
  }
}

// The period a date falls in, as a Timeline slot's label and window.
function periodOf(start: number, gran: string): { label: string; window: [number, number] } {
  const d = new Date(start)
  return { label: bucketDateLabel(d, gran), window: [start, nextPeriodStart(d, gran).getTime() - 1] }
}

// The dates of the records behind a time-tracked metric for one row — the hours it logged, the
// allocations it booked — reached the same way resolveFieldForRow reaches their values.
function metricRecordTimes(grainModule: string, row: Row, metricKey: string): number[] {
  const mod = fieldKeyModule(metricKey)
  const df = ROLLUP_DATE_FIELD[mod]
  if (!df) return []
  const at = (v: any) => (v instanceof Date ? v : new Date(v)).getTime()
  if (mod === grainModule) return row[df] ? [at(row[df])] : []
  const fk = ROLLUP_FK[mod]
  if (!fk) return []
  const matchId = MODULE_OWN_ID_KEY[grainModule] === fk ? row.id : row[fk]
  const records = matchId != null ? (ROLLUP_INDEX[mod]?.get(matchId) ?? []) : []
  return records.filter((r) => r[df]).map((r) => at(r[df]))
}

// What a Timeline filter can pick at one granularity: the periods its metrics have records in,
// read from each metric's own date (hours when logged, allocations when booked…) rather than a
// generic calendar. Recurring granularities run in calendar order (every January together),
// the rest chronologically. `within` keeps only records inside another Timeline filter — a view
// filter offers only what the report's own Timeline lets through.
function timelineActualValues(metricKeys: string[], gran: string, within: DateWindow | null = null): string[] {
  const order = new Map<string, number>()
  new Set(metricKeys.map(fieldKeyModule)).forEach((mod) => {
    const df = ROLLUP_DATE_FIELD[mod]
    if (!df) return
    ;(MODULE_ROWS[mod] ?? []).forEach((r) => {
      const v = r[df]
      if (!v) return
      const d = v instanceof Date ? v : new Date(v)
      if (within && !within(d.getTime())) return
      const label = bucketDateLabel(d, gran)
      const key = gran === "Month" ? d.getMonth()
        : gran === "Quarter" ? quarterOf(d)
        : gran === "Week" ? isoWeekNumber(d)
        : d.getTime()
      const prev = order.get(label)
      if (prev === undefined || key < prev) order.set(label, key)
    })
  })
  return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label)
}

// Does this metric chip answer to the Timeline? Only time-tracked metrics can, and the user may
// exempt one from the Timeline filter's checklist — it then keeps its own calendar, unsplit.
function followsTimeline(item: PivotItem, tlRule: FilterRule | undefined): boolean {
  return TIMELINE_METRICS_SET.has(item.field) && !(tlRule?.tlExempt ?? []).includes(item.id)
}

// ── Filter evaluation ─────────────────────────────────────────────────────────────
// A date input's "YYYY-MM-DD" as a local day — its first instant, or with `endOfDay` its last, so
// "between 1 Mar and 30 Apr" keeps the 30th. new Date("YYYY-MM-DD") would read UTC midnight.
function localDay(iso: string, endOfDay = false): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso ? new Date(iso) : null
  return endOfDay
    ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999)
    : new Date(+m[1], +m[2] - 1, +m[3])
}

function dateRuleMatches(raw: any, rule: FilterRule): boolean {
  if (raw == null || raw === "") return rule.dateIncludeNull === true
  const d = raw instanceof Date ? raw : new Date(raw)
  const mode = rule.dateMode ?? "actual"
  if (mode === "actual") {
    if (!rule.values || rule.values.length === 0) return true
    return rule.values.includes(bucketDateLabel(d, rule.dateGranularity || "Month & Year"))
  }
  if (mode === "range") {
    const from = rule.dateFrom ? localDay(rule.dateFrom) : null
    const to = rule.dateTo ? localDay(rule.dateTo, true) : null
    const op = rule.dateRangeOp ?? "after"
    if (op === "after") return from ? d.getTime() >= from.getTime() : true
    if (op === "before") return from ? d.getTime() <= from.getTime() : true
    const lo = from ? from.getTime() : -Infinity
    const hi = to ? to.getTime() : Infinity
    return d.getTime() >= lo && d.getTime() <= hi
  }
  if (!rule.dateRelativeOpt) return true
  const win = relativeWindow(rule.dateGranularity || "Month & Year", rule.dateRelativeOpt, rule.dateRelativeN || 1, TODAY)
  if (!win) return true
  return d.getTime() >= win[0].getTime() && d.getTime() <= win[1].getTime()
}

// Tests a single already-computed number (a group-level aggregate — see applyGroupLevelFilters
// below) against the NumericFilterModal/CategoricalFilterModal's Actual/Range/Relative tabs.
// "actual": rule.values is the checked number set. "range": rule.value/value2 are the [lo, hi]
// bounds (unset = open on that side). "relative": keeps groups on the Top/Bottom side of a
// threshold computed across all of the report's own groups (see applyGroupLevelFilters).
function numericRuleMatches(raw: any, rule: FilterRule, relativeThreshold?: number): boolean {
  const isEmpty = raw == null || raw === ""
  if (isEmpty) return false
  const n = Number(raw)
  if (Number.isNaN(n)) return false

  const mode = rule.numMode ?? "actual"
  if (mode === "actual") {
    const selected = rule.values ?? []
    if (selected.length === 0) return true
    return selected.some((v) => Number(v) === n)
  }
  if (mode === "range") {
    const lo = rule.value !== "" && rule.value != null ? Number(rule.value) : -Infinity
    const hi = rule.value2 !== "" && rule.value2 != null ? Number(rule.value2) : Infinity
    return n >= lo && n <= hi
  }
  // relative
  if (relativeThreshold == null) return true
  return rule.relativeDirection === "Bottom" ? n <= relativeThreshold : n >= relativeThreshold
}

// The FilterChip's checkbox picker always writes selections into `rule.values`, for
// every non-empty/non-range operator (not just "is one of.../is none of...") — so
// "is exactly..." with a picker really means "value is in the checked set", same as
// "is one of...". Falls back to the free-text `rule.value` only when no picker exists.
function booleanRuleMatches(raw: any, rule: FilterRule): boolean {
  const isEmpty = raw == null
  if (rule.operator === "is empty") return isEmpty
  if (rule.operator === "is not empty") return !isEmpty
  const boolVal = raw === true || raw === "Yes"
  const negate = rule.operator === "is not..."
  const selected = rule.values && rule.values.length > 0 ? rule.values : rule.value ? [rule.value] : []
  if (selected.length === 0) return true
  const inSet = selected.includes(boolVal ? "Yes" : "No")
  return negate ? !inSet : inSet
}

// One wildcard condition row vs. an already-lowercased field value. `cond.value` is
// trimmed + lowercased here too so callers never have to normalize it themselves.
function wildcardConditionMatches(strLower: string, cond: { matchType: WildcardMatchType; value: string }): boolean {
  const v = cond.value.trim().toLowerCase()
  switch (cond.matchType) {
    case "Exactly Matches": return strLower === v
    case "Does Not Match": return strLower !== v
    case "Contains": return strLower.includes(v)
    case "Does Not Contain": return !strLower.includes(v)
    case "Starts With": return strLower.startsWith(v)
    case "Does Not Start With": return !strLower.startsWith(v)
    case "Ends With": return strLower.endsWith(v)
    case "Does Not End With": return !strLower.endsWith(v)
    default: return true
  }
}

// Categorical (text/person) filter — driven by the CategoricalFilterModal's two tabs.
// "actual": rule.values is the checked set; catMatchMode "any"/"none" decide membership vs.
// exclusion (row-level only — "all"/"only" are group-level and never reach this function, see
// isSetMembershipFilterRule). "wildcard": every non-blank condition in wildcardConditions is
// OR'd together; if none are configured, wildcardIncludeEmpty (default true) decides whether
// that's "no filter" or "filter everything out".
function textRuleMatches(raw: any, rule: FilterRule): boolean {
  const str = raw == null ? "" : String(raw)
  if (str === "") return false // a blank field value never passes a text filter
  const lower = str.toLowerCase()

  if ((rule.catMode ?? "actual") === "wildcard") {
    const conds = (rule.wildcardConditions ?? []).filter((c) => (c.value ?? "").trim() !== "")
    if (conds.length === 0) return rule.wildcardIncludeEmpty !== false
    return conds.some((c) => wildcardConditionMatches(lower, c))
  }

  // Resolved against whoever is viewing, so the same saved rule answers differently per person.
  if (isCurrentUserMode(rule.catMatchMode)) {
    const isMe = lower === getCurrentUserName().toLowerCase()
    return rule.catMatchMode === "me" ? isMe : !isMe
  }

  const selected = rule.values ?? []
  if (selected.length === 0) return true
  const inSet = selected.some((v) => v.toLowerCase() === lower)
  return (rule.catMatchMode ?? "any") === "none" ? !inSet : inSet
}

// The values a text/person filter should test for this row. One value normally; every member
// when the role is one-to-many. Reads the rule's role, which withFilterRoles has already settled
// against the base grain so it means what the user picked whatever grain the report ends up at.
function filterValuesForRow(grainModule: string, row: Row, rule: FilterRule): any[] {
  const v = resolveFieldForRow(grainModule, row, rule.field, null, rule.lookupPath)
  // A multi-value answer is tested value by value, like the members above; an empty one reads as
  // a single blank so "none of" treats it the way it treats any blank.
  if (Array.isArray(v)) return v.length > 0 ? v : [undefined]
  return [v]
}

// "None of" and "not me" must hold for EVERY value a row has; the positive modes need just one.
// With a single value per row the two readings agree, so this only changes one-to-many filters:
// "member is not me" excludes any project I am on, rather than passing it because someone else is.
function textRuleMatchesAll(values: any[], rule: FilterRule): boolean {
  const negative = (rule.catMode ?? "actual") !== "wildcard"
    && (rule.catMatchMode === "none" || rule.catMatchMode === "notMe")
  return negative ? values.every((v) => textRuleMatches(v, rule)) : values.some((v) => textRuleMatches(v, rule))
}

// Each rule with its relationship role resolved against the BASE grain — the same rule chips use,
// so a filter and a chip on the same field read the same people. Done once, up front, because a
// chip choosing a one-to-many role can raise the grain, and a role re-derived after that would no
// longer see the choices the user was offered.
function withFilterRoles(baseGrain: string, rules: FilterRule[], source?: string): FilterRule[] {
  return rules.map((r) => {
    const role = effectiveLookupPath(baseGrain, r.field, r.lookupPath, source)
    return role === r.lookupPath ? r : { ...r, lookupPath: role }
  })
}

function ruleMatches(grainModule: string, row: Row, rule: FilterRule): boolean {
  // The Timeline narrows metrics, never the population: "all projects ever created" with
  // "hours this month" must still list every project.
  if (rule.field === TIMELINE_KEY) return true
  // Numeric rules, and Count/Distinct-Count-treated categorical rules, are group-level
  // ("HAVING"-style) — they don't apply per raw row at all; computeReportData prunes
  // comboEntries with them separately, after grouping (see applyGroupLevelFilters).
  if (isGroupLevelFilterRule(rule)) return true
  if (rule.type === "text" || rule.type === "person") return textRuleMatchesAll(filterValuesForRow(grainModule, row, rule), rule)
  const raw = resolveFieldForRow(grainModule, row, rule.field, null, rule.lookupPath)
  if (rule.type === "date") return dateRuleMatches(raw, rule)
  if (rule.type === "boolean") return booleanRuleMatches(raw, rule)
  return textRuleMatches(raw, rule)
}
function rowPassesFilters(grainModule: string, row: Row, rules: FilterRule[]): boolean {
  for (const rule of rules) if (!ruleMatches(grainModule, row, rule)) return false
  return true
}

// ── Tabular (flat) filtering ──────────────────────────────────────────────────────
// A tabular report lists records, so EVERY filter compares the record's own value — there are
// no pivot groups to aggregate over. That is the one real semantic difference from the pivot
// builder, and it has to be explicit: `ruleMatches` above short-circuits numeric rules to true
// on the promise that applyGroupLevelFilters prunes them later, so reusing it unchanged would
// leave a tabular numeric filter silently doing nothing.
function tabularRuleMatches(grainModule: string, row: Row, rule: FilterRule, relativeThreshold?: number): boolean {
  if (rule.field === TIMELINE_KEY) return true
  if (rule.type === "text" || rule.type === "person") return textRuleMatchesAll(filterValuesForRow(grainModule, row, rule), rule)
  const raw = resolveFieldForRow(grainModule, row, rule.field, null, rule.lookupPath)
  if (rule.type === "date") return dateRuleMatches(raw, rule)
  if (rule.type === "boolean") return booleanRuleMatches(raw, rule)
  if (isNumericType(rule.type)) return numericRuleMatches(raw, rule, relativeThreshold)
  return textRuleMatches(raw, rule)
}

function isRelativeNumericRule(rule: FilterRule): boolean {
  return isNumericType(rule.type) && (rule.numMode ?? "actual") === "relative"
}

// Two passes, because Top/Bottom-N can only be judged once the other rules have decided who is
// in the running: apply every absolute rule first, then rank the survivors per relative rule.
function filterRowsFlat(grainModule: string, rows: Row[], rules: FilterRule[]): Row[] {
  const absolute = rules.filter((r) => !isRelativeNumericRule(r))
  let result = rows.filter((row) => absolute.every((rule) => tabularRuleMatches(grainModule, row, rule)))

  rules.filter(isRelativeNumericRule).forEach((rule) => {
    const values = result
      .map((row) => Number(resolveFieldForRow(grainModule, row, rule.field, null)))
      .filter((n) => !Number.isNaN(n))
    if (values.length === 0) return
    const dir = rule.relativeDirection ?? "Top"
    const sorted = [...values].sort((a, b) => (dir === "Bottom" ? a - b : b - a))
    const n = Math.min(Math.max(1, Math.floor(rule.relativeN) || 5), sorted.length)
    const threshold = sorted[n - 1]
    result = result.filter((row) => tabularRuleMatches(grainModule, row, rule, threshold))
  })

  return result
}

// ── Row/column label building (grouping) ──────────────────────────────────────────
function formatMoneyish(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(Math.round(n))
}
// A "nice" default window size for equal-window bucketing — the smallest value of the form
// {1,2,5,10} × 10^k that's still ≥ span/5, so the default lands on ~5 round-numbered buckets
// (e.g. a 73-point span defaults to a size of 20, not an ugly 14.6).
function niceBucketSize(span: number): number {
  if (span <= 0) return 1
  const rough = span / 5
  const exp = Math.floor(Math.log10(rough))
  const base = Math.pow(10, exp)
  const candidates = [1, 2, 5, 10].map((m) => m * base)
  return candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1]
}

function rangeBucketLabel(n: number, type: FieldType, bounds: { min: number; max: number }, config?: RangeConfig): string {
  const fmt = (v: number) => type === "percent" ? `${Math.round(v)}%` : type === "money" ? `$${formatMoneyish(v)}` : type === "hours" ? `${formatMoneyish(v)}h` : formatMoneyish(v)

  if (config?.mode === "custom" && config.customBounds.length > 0) {
    const edges = [...new Set(config.customBounds)].sort((a, b) => a - b)
    if (n < edges[0]) return `< ${fmt(edges[0])}`
    for (let i = 0; i < edges.length - 1; i++) {
      if (n >= edges[i] && n < edges[i + 1]) return `${fmt(edges[i])} – ${fmt(edges[i + 1])}`
    }
    return `${fmt(edges[edges.length - 1])}+`
  }

  const span = Math.max(1, bounds.max - bounds.min)
  const size = config?.bucketSize && config.bucketSize > 0 ? config.bucketSize : niceBucketSize(span)
  let idx = Math.floor((n - bounds.min) / size)
  if (idx < 0) idx = 0
  const lo = bounds.min + idx * size
  const hi = lo + size
  return hi >= bounds.max ? `${fmt(lo)}+` : `${fmt(lo)} – ${fmt(hi)}`
}

interface FieldLabeler {
  label: (row: Row) => string
  sortKey: (row: Row) => number | string
  /** Set for a multi-value field: every group the record belongs in, one per value it holds. */
  labels?: (row: Row) => { label: string; sortKey: number | string }[]
}

// Every group a record falls in for this labeler: one normally, one per value for a multi-value one.
function labelOptions(l: FieldLabeler, row: Row): { label: string; sortKey: number | string }[] {
  return l.labels ? l.labels(row) : [{ label: l.label(row), sortKey: l.sortKey(row) }]
}

// Each record's group per labeler, crossed — a record with two values in one field and two in
// another sits in four combinations.
function labelCombos(labelers: FieldLabeler[], row: Row): { labels: string[]; sortKeys: (number | string)[] }[] {
  let out: { labels: string[]; sortKeys: (number | string)[] }[] = [{ labels: [], sortKeys: [] }]
  labelers.forEach((l) => {
    const opts = labelOptions(l, row)
    out = out.flatMap((c) => opts.map((o) => ({ labels: [...c.labels, o.label], sortKeys: [...c.sortKeys, o.sortKey] })))
  })
  return out
}

// `window` narrows a time-tracked field to the Timeline filter's period before it is grouped on —
// projects banded by their hours this month, not their hours ever.
function buildLabeler(grainModule: string, sampleRows: Row[], item: PivotItem, aggregations: Record<string, string>, rangeConfigs: Record<string, RangeConfig>, lookupPaths: Record<string, string> = {}, window: DateWindow | null = null): FieldLabeler {
  const type = getFieldType(item.field)
  const modifier = aggregations[item.id]
  const resolve = (row: Row) => resolveFieldForRow(grainModule, row, item.field, window, lookupPaths[item.id])

  // A form answer: a skipped question groups as "(No answer)" — last — and choices keep the form's
  // own option order rather than the alphabet.
  const answer = FORM_ANSWER_FIELDS.get(item.field)
  if (answer && !isNumericType(type) && type !== "date" && type !== "boolean") {
    const order = answer.question.options ?? []
    const keyOf = (v: string): number | string => { const i = order.indexOf(v); return i === -1 ? v : i }
    // Last either way: past every option index, or past every name for a free-text / person answer.
    const NO_ANSWER = { label: "(No answer)", sortKey: order.length ? Infinity : "\uffff" }
    const values = (row: Row): string[] => {
      const raw = resolve(row)
      return (Array.isArray(raw) ? raw : [raw]).filter((v) => v != null && v !== "").map(String)
    }
    return {
      label: (row) => values(row).join(", ") || NO_ANSWER.label,
      sortKey: (row) => { const v = values(row); return v.length ? keyOf(v[0]) : NO_ANSWER.sortKey },
      labels: answer.multi
        ? (row) => { const v = values(row); return v.length ? v.map((x) => ({ label: x, sortKey: keyOf(x) })) : [NO_ANSWER] }
        : undefined,
    }
  }

  const blank = answer ? "(No answer)" : "(blank)"
  if (type === "date") {
    const gran = modifier || "Quarter & Year"
    return {
      label: (row) => { const raw = resolve(row); return raw == null || raw === "" ? blank : bucketDateLabel(raw instanceof Date ? raw : new Date(raw), gran) },
      sortKey: (row) => { const raw = resolve(row); return raw == null || raw === "" ? Infinity : (raw instanceof Date ? raw : new Date(raw)).getTime() },
    }
  }
  if (isNumericType(type) && modifier !== "Dimension") {
    const nums = sampleRows.map(resolve).filter((v) => v != null && v !== "").map(Number).filter((n) => !Number.isNaN(n))
    const bounds = nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: 0, max: 1 }
    const rangeConfig = rangeConfigs[item.id]
    return {
      label: (row) => { const raw = resolve(row); return raw == null || raw === "" ? blank : rangeBucketLabel(Number(raw), type, bounds, rangeConfig) },
      sortKey: (row) => { const raw = resolve(row); return raw == null || raw === "" ? Infinity : Number(raw) },
    }
  }
  if (isNumericType(type)) { // "Dimension" mode — exact value
    return {
      label: (row) => { const raw = resolve(row); return raw == null || raw === "" ? blank : String(raw) },
      sortKey: (row) => { const raw = resolve(row); return raw == null || raw === "" ? Infinity : Number(raw) },
    }
  }
  if (type === "boolean") {
    return {
      label: (row) => { const raw = resolve(row); return raw == null ? blank : raw ? "Yes" : "No" },
      sortKey: (row) => { const raw = resolve(row); return raw == null ? "" : raw ? "0" : "1" },
    }
  }
  // A one-to-many Team member role (a task's project members): the record goes under every person
  // it names, and totals count it once.
  if (PERSON_ROLES[normalizeRoleId(lookupPaths[item.id]) ?? ""]?.idsKey) {
    const names = (row: Row): string[] => {
      const raw = resolve(row)
      return (Array.isArray(raw) ? raw : [raw]).filter((v) => v != null && v !== "").map(String)
    }
    return {
      label: (row) => names(row).join(", ") || blank,
      sortKey: (row) => names(row)[0] ?? "￿",
      labels: (row) => { const n = names(row); return n.length ? n.map((x) => ({ label: x, sortKey: x })) : [{ label: blank, sortKey: "￿" }] },
    }
  }
  return {
    label: (row) => { const raw = resolve(row); return raw == null || raw === "" ? blank : String(raw) },
    sortKey: (row) => { const raw = resolve(row); return raw == null || raw === "" ? "" : String(raw) },
  }
}

// ── Values aggregation ─────────────────────────────────────────────────────────────
// A value field coarser than the report's grain (e.g. Project::ARR while the report is
// at Task grain) would otherwise fan out — the same ARR counted once per task instead
// of once per project. Dedupe by the owning dimension's id before summing/averaging so
// the number stays the real, non-inflated figure.
function aggregateBucket(bucketRows: Row[], grainModule: string, item: PivotItem, agg: string, type: FieldType, timelineFilter?: MetricFilter, role?: string, windowOverride?: DateWindow | null): number {
  const targetModule = fieldKeyModule(item.field)

  let dateWindow: DateWindow | null = null
  // A window handed in (the Timeline's period, or one column of it) replaces the chip's own
  // calendar; `undefined` means "none handed in" and falls through to the chip's calendar.
  if (windowOverride !== undefined) {
    if (TIMELINE_METRICS_SET.has(item.field)) dateWindow = windowOverride
  } else if (TIMELINE_METRICS_SET.has(item.field)) {
    dateWindow = metricFilterWindow(timelineFilter)
  }

  // Counting a question counts the submissions that answered it — a skipped question is not a
  // response, and a multi-select answer is still one submission however many options it ticks.
  if (agg === "Count" && FORM_ANSWER_FIELDS.has(item.field)) {
    return bucketRows.filter((r) => {
      const v = resolveFieldForRow(grainModule, r, item.field, null, role)
      return Array.isArray(v) ? v.length > 0 : v != null && v !== "" && v !== false
    }).length
  }
  // A rolled-up table counts its own records, not the report rows they hang off.
  const countFk = targetModule !== grainModule && !DIMENSION_ID_KEY[targetModule] ? ROLLUP_FK[targetModule] : undefined
  if (agg === "Count" && countFk) {
    const key = MODULE_OWN_ID_KEY[grainModule] === countFk ? "id" : countFk
    const dateField = ROLLUP_DATE_FIELD[targetModule]
    const owners = new Set(bucketRows.map((r) => r[key]).filter((id) => id != null))
    let n = 0
    owners.forEach((id) => {
      const recs = ROLLUP_INDEX[targetModule]?.get(id) ?? []
      n += dateWindow && dateField ? recs.filter((r) => withinWindow(r[dateField], dateWindow!)).length : recs.length
    })
    return n
  }
  if (agg === "Count") {
    if (dateWindow && targetModule === grainModule) {
      const ownDateField = ROLLUP_DATE_FIELD[targetModule]
      if (ownDateField) return bucketRows.filter((r) => withinWindow(r[ownDateField], dateWindow!)).length
    }
    return bucketRows.length
  }

  const isDim = targetModule !== grainModule && !!DIMENSION_ID_KEY[targetModule]
  // A sibling collection (expenses beside time entries) is rolled up per parent it hangs off —
  // every time entry on a task would otherwise bring that task's expenses in again.
  const rollupFk = !isDim && targetModule !== grainModule ? ROLLUP_FK[targetModule] : undefined
  const ownerKey = isDim ? DIMENSION_ID_KEY[targetModule]
    : rollupFk ? (MODULE_OWN_ID_KEY[grainModule] === rollupFk ? "id" : rollupFk) : undefined
  const seen = new Set<string>()
  const values: any[] = []
  for (const row of bucketRows) {
    if (ownerKey) {
      const ownerId = row[ownerKey]
      if (ownerId != null) {
        if (seen.has(ownerId)) continue
        seen.add(ownerId)
      }
    }
    const v = resolveFieldForRow(grainModule, row, item.field, dateWindow, role)
    if (v !== undefined && v !== null && v !== "") values.push(v)
  }

  // Distinct values across the bucket — for a multi-value answer, the different options used.
  if (agg === "Distinct Count") return new Set(values.flat().map((v) => String(v))).size
  if (!isNumericType(type) && values.some(Array.isArray)) return values.filter((v) => !Array.isArray(v) || v.length > 0).length
  if (!isNumericType(type)) return values.length

  const nums = values.map(Number).filter((n) => !Number.isNaN(n))
  if (nums.length === 0) return 0
  if (agg === "Average") return nums.reduce((a, b) => a + b, 0) / nums.length
  if (agg === "Min") return Math.min(...nums)
  if (agg === "Max") return Math.max(...nums)
  return nums.reduce((a, b) => a + b, 0)
}

// ── Group-level ("HAVING"-style) filters ──────────────────────────────────────────
// Every numeric filter, and a categorical field's catTreatment "count"/"distinctCount"
// (instead of "categorical"), are group-level — rather than filtering raw rows by the
// field's own value, they filter the REPORT'S OWN pivot rows by a group-level aggregate of
// that field (same computation a Values chip would do, via aggregateBucket), reusing
// numericRuleMatches + the numMode/relativeDirection/relativeN/values/value/value2 fields
// already on FilterRule. Which of the 6 aggregateBucket functions to use is resolved by
// filterAggFunction: a numeric field's own numFunction, or Count/Distinct Count for a
// categorical field's catTreatment.
//
// A THIRD kind of group-level rule: a "categorical"-treatment field whose catMatchMode is
// "all"/"only" (see isSetMembershipFilterRule). This isn't a scalar-aggregate comparison at
// all — it's a set-containment check ("does this group's distinct value-set for the field
// include every checked value, or exactly the checked values") — so it bypasses
// filterAggFunction/comboAggregateValue/numericRuleMatches entirely; see the dedicated branch
// in applyGroupLevelFilters below.

type ComboEntry = { combo: string[]; sortTuple: (number | string)[]; cols: Map<string, Row[]> }

// Only true for a categorical (non-wildcard, "categorical"-treatment) rule whose Actual-tab
// match mode is "all" or "only" — "any"/"none" stay row-level (see textRuleMatches). The
// catMode==="wildcard" guard matters because catMatchMode/catMode are independent state: a
// user can leave catMatchMode="all" set while switched to the Wildcard tab, and without this
// guard the rule would still be misclassified as group-level, short-circuited to `true` per
// row, and silently ignore the user's actual wildcardConditions.
function isSetMembershipFilterRule(rule: FilterRule): boolean {
  if (rule.type !== "text" && rule.type !== "person") return false
  if (rule.catTreatment && rule.catTreatment !== "categorical") return false
  if ((rule.catMode ?? "actual") === "wildcard") return false
  const mode = rule.catMatchMode ?? "any"
  return mode === "all" || mode === "only"
}

function isGroupLevelFilterRule(rule: FilterRule): boolean {
  if (isNumericType(rule.type)) return true
  if ((rule.type === "text" || rule.type === "person") && !!rule.catTreatment && rule.catTreatment !== "categorical") return true
  return isSetMembershipFilterRule(rule)
}

function filterAggFunction(rule: FilterRule): string {
  if (isNumericType(rule.type)) return rule.numFunction || "Sum"
  return rule.catTreatment === "distinctCount" ? "Distinct Count" : "Count"
}

function groupAggregateFromRows(rows: Row[], grainModule: string, fieldKey: string, agg: string): number {
  return aggregateBucket(rows, grainModule, { id: "__filter__", field: fieldKey }, agg, getFieldType(fieldKey))
}

function comboAggregateValue(entry: ComboEntry, grainModule: string, fieldKey: string, agg: string): number {
  // A record split across this group's columns is still one record of the group.
  return groupAggregateFromRows([...new Set(([] as Row[]).concat(...entry.cols.values()))], grainModule, fieldKey, agg)
}

// The distinct, case-insensitive, blank-excluding value-set a group's rows carry for a
// field — same conventions as textRuleMatches — via resolveFieldForRow (the same per-row
// resolver aggregateBucket already uses, so this is grain-correct for free: e.g. resolves
// Role::Role name off an Allocations row's roleId, or Task::Assignees directly off a Task row).
function groupDistinctValues(rows: Row[], grainModule: string, fieldKey: string, role?: string): Set<string> {
  const set = new Set<string>()
  // Same resolution a row filter uses, so "all of" / "only" read the same people — every
  // member, where the role is one-to-many.
  const probe = { field: fieldKey, lookupPath: role } as FilterRule
  rows.forEach((row) => {
    filterValuesForRow(grainModule, row, probe).forEach((raw) => {
      if (raw == null || raw === "") return
      set.add(String(raw).toLowerCase())
    })
  })
  return set
}
function groupContainsAllValues(rows: Row[], grainModule: string, fieldKey: string, checked: string[], role?: string): boolean {
  if (checked.length === 0) return true
  const distinct = groupDistinctValues(rows, grainModule, fieldKey, role)
  return checked.every((v) => distinct.has(v.toLowerCase()))
}
function groupContainsExactlyValues(rows: Row[], grainModule: string, fieldKey: string, checked: string[], role?: string): boolean {
  if (checked.length === 0) return true
  const distinct = groupDistinctValues(rows, grainModule, fieldKey, role)
  return distinct.size === checked.length && checked.every((v) => distinct.has(v.toLowerCase()))
}

function applyGroupLevelFilters(entries: ComboEntry[], rules: FilterRule[], grainModule: string): ComboEntry[] {
  let result = entries
  rules.forEach((rule) => {
    if (isSetMembershipFilterRule(rule)) {
      const checked = rule.values ?? []
      if (checked.length === 0) return // nothing checked yet — no filter, matches every group
      const exact = rule.catMatchMode === "only"
      result = result.filter((e) => {
        // Read every row of the group to test containment, but never filter e.cols itself —
        // a surviving group's Values totals must still reflect ALL of its rows, not just the
        // ones carrying a checked value.
        const rows = ([] as Row[]).concat(...e.cols.values())
        return exact
          ? groupContainsExactlyValues(rows, grainModule, rule.field, checked, rule.lookupPath)
          : groupContainsAllValues(rows, grainModule, rule.field, checked, rule.lookupPath)
      })
      return
    }
    const agg = filterAggFunction(rule)
    const values = result.map((e) => comboAggregateValue(e, grainModule, rule.field, agg))
    let threshold: number | undefined
    if ((rule.numMode ?? "actual") === "relative" && values.length > 0) {
      const dir = rule.relativeDirection ?? "Top"
      const sorted = [...values].sort((a, b) => (dir === "Bottom" ? a - b : b - a))
      const n = Math.min(Math.max(1, Math.floor(rule.relativeN) || 5), sorted.length)
      threshold = sorted[n - 1]
    }
    result = result.filter((_, i) => numericRuleMatches(values[i], rule, threshold))
  })
  return result
}

// Shared grouping step behind every filter-modal live preview: filters rows (skipping this
// report's own group-level rules, same as computeReportData), then buckets them by the
// current Rows fields' labels — the report's own pivot-row groups, reused as the "parent
// entity" for both scalar-aggregate previews and set-membership previews below.
function previewGroupRows(
  source: string, fields: PivotFields, aggregations: Record<string, string>, filterRules: FilterRule[],
  rangeConfigs: Record<string, RangeConfig>, lookupPaths: Record<string, string> = {},
): { grainModule: string; groups: Row[][] } {
  const grainModule = pickGrain(source, fields, filterRules)
  const allRows: Row[] = MODULE_ROWS[grainModule] ?? []
  const roledRules = withFilterRoles(grainModule, filterRules, source)
  const filteredRows = allRows.filter((row) => rowPassesFilters(grainModule, row, roledRules))

  const rowFields = fields.rows.filter((r) => r.field !== TIMELINE_KEY)
  if (rowFields.length === 0) return { grainModule, groups: [filteredRows] }

  const rowLabelers = rowFields.map((item) => buildLabeler(grainModule, filteredRows, item, aggregations, rangeConfigs, lookupPaths))
  const groups = new Map<string, Row[]>()
  filteredRows.forEach((row) => {
    labelCombos(rowLabelers, row).forEach(({ labels }) => {
      const key = labels.join("␟")
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    })
  })
  return { grainModule, groups: [...groups.values()] }
}

// Live preview of what comboAggregateValue would compute for every current pivot row —
// backs the Count/Distinct-Count/Function filter modals' Actual (checkbox list) and Range
// (slider bounds) tabs, which need to know what aggregate values are actually possible now.
function previewGroupAggregates(
  source: string, fields: PivotFields, aggregations: Record<string, string>, filterRules: FilterRule[],
  targetFieldKey: string, agg: string, rangeConfigs: Record<string, RangeConfig>,
): number[] {
  const { grainModule, groups } = previewGroupRows(source, fields, aggregations, filterRules, rangeConfigs)
  return groups.map((rows) => groupAggregateFromRows(rows, grainModule, targetFieldKey, agg))
}

// Live preview for the "all of"/"only" match modes: how many of the report's current pivot
// groups would survive, plus (regardless of survival) the best overlap any single group
// achieves — the honest, no-jargon way of surfacing a degenerate case (a field with only one
// value per group will always top out at 1, whether or not "all of" is even satisfiable —
// same message either way, no grain-comparison logic needed).
function previewSetMembershipOverlap(
  source: string, fields: PivotFields, aggregations: Record<string, string>, filterRules: FilterRule[],
  targetFieldKey: string, checked: string[], exact: boolean, rangeConfigs: Record<string, RangeConfig>,
): { matching: number; total: number; bestOverlap: number } {
  const { grainModule, groups } = previewGroupRows(source, fields, aggregations, filterRules, rangeConfigs)
  let matching = 0
  let bestOverlap = 0
  groups.forEach((rows) => {
    const distinct = groupDistinctValues(rows, grainModule, targetFieldKey)
    const overlap = checked.filter((v) => distinct.has(v.toLowerCase())).length
    const passes = exact ? distinct.size === checked.length && overlap === checked.length : overlap === checked.length
    if (passes) matching++
    bestOverlap = Math.max(bestOverlap, overlap)
  })
  return { matching, total: groups.length, bestOverlap }
}

// A View filter's value picker must only offer values that survive the BASE filters — a viewer
// should never see an option the report's own scope already excluded (picking it would just
// yield an empty report). Resolves through resolveFieldForRow at the report's real grain, so the
// list matches how filtering ACTUALLY behaves rather than the raw dataset. Mirrors fieldValues'
// contract exactly (Yes/No for boolean, null for non-categorical, null when empty) so it's a
// drop-in override for it.
//   grainRules  = base + view combined, so the grain matches the report's own
//   scopeRules  = base only — the narrowing this list must respect
function relevantFieldValues(
  source: string, fields: PivotFields, grainRules: FilterRule[], scopeRules: FilterRule[],
  fieldKey: string, type: FieldType, lookupPath?: string,
): string[] | null {
  if (type === "boolean") return ["Yes", "No"]
  if (type !== "text" && type !== "person") return null
  const grainModule = pickGrain(source, fields, grainRules)
  const roledScope = withFilterRoles(grainModule, scopeRules, source)
  // The offered values must come through the same relationship the filter will test, or the
  // list would show owners while the filter matched members (or show nothing at all).
  const probe = withFilterRoles(grainModule, [{ field: fieldKey, lookupPath } as FilterRule], source)[0]
  const values = new Set<string>()
  ;(MODULE_ROWS[grainModule] ?? []).forEach((row) => {
    if (!rowPassesFilters(grainModule, row, roledScope)) return
    filterValuesForRow(grainModule, row, probe).forEach((v) => {
      if (v != null && v !== "") values.add(String(v))
    })
  })
  return values.size > 0 ? [...values].sort((a, b) => a.localeCompare(b)) : null
}

// ── Full report computation: filter → group (rows × first column) → aggregate ────────
interface ComputedReport {
  displayRows: string[][]
  colValues: string[]
  colTuples: string[][]
  /** The Values (by index) shown under each data column. */
  colItems: number[][]
  hasColumns: boolean
  hasValues: boolean
  cellNum: (ri: number, ci: number, vi: number) => number
  grandTotals: number[]
  bucketRows: (ri: number, ci: number) => Row[]
  grainModule: string
  /** Set when a one-to-many role has fanned the rows out, so measures from the "one" side are
      counted once per joined row. Silence here would be a total that looks right and isn't. */
  fanoutNotice: string | null
  /** A row's total across the columns — not always the sum of its cells, since a metric the
      Timeline doesn't split has blank period cells and a real total. */
  rowTotal: (ri: number, vi: number) => number
  /** A column cell, and the total, for a group of displayed rows — subtotals and grand totals. */
  groupCell: (leaves: number[], ci: number, vi: number) => number
  groupTotal: (leaves: number[], vi: number) => number
  timelineNotices: string[]
}

function computeReportData(
  source: string,
  fields: PivotFields,
  aggregations: Record<string, string>,
  filterRules: FilterRule[],
  viewFilterRules: FilterRule[],
  timelineFilters: Record<string, MetricFilter>,
  rangeConfigs: Record<string, RangeConfig>,
  lookupPaths: Record<string, string> = {},
): ComputedReport {
  // Base Filters are the report's own locked scope; View filters run on top of that result.
  // Concatenating in THIS order is what encodes the hierarchy: applyGroupLevelFilters narrows
  // sequentially, so a view-level Top-N ranks only among the groups base filters left standing.
  const allRules = viewFilterRules.length > 0 ? [...filterRules, ...viewFilterRules] : filterRules
  const grainModule = pickGrainWithRoles(source, fields, allRules, lookupPaths)
  // From here on "lookupPaths" means each chip's resolved role, not its raw choice.
  const baseGrain = pickGrain(source, fields, allRules)
  const chipRoles = resolveChipRoles(baseGrain, fields, lookupPaths, source)
  // A chip whose chosen role's module has left the report reads through the default role now.
  const roleNotices: string[] = []
  ;[...fields.columns, ...fields.rows, ...fields.values].forEach((item) => {
    if (!lookupFellBack(baseGrain, item.field, lookupPaths[item.id], source)) return
    const was = PERSON_ROLES[normalizeRoleId(lookupPaths[item.id])!]
    const now = chipRoles[item.id]
    roleNotices.push(`${fieldDisplayName(item.field)} now shows ${now ? roleDisplayName(now) : "the default role"}: a ${source.toLowerCase()} report can't use ${was.module} ${was.label.toLowerCase().replace(new RegExp(`^${was.module.toLowerCase()} `), "")}.`)
  })
  lookupPaths = chipRoles

  // A role that raised the grain repeats every "one"-side measure across the many rows it
  // joined to. Name the affected measures rather than leaving an inflated total to be found.
  let fanoutNotice: string | null = null
  if (grainModule !== baseGrain) {
    const fanned = fields.values.filter((v) => fieldKeyModule(v.field) === baseGrain)
    const role = Object.values(chipRoles).find((r) => ROLE_GRAIN[roleFkKey(baseGrain, "People", r)])
    if (fanned.length > 0) {
      const names = fanned.map((v) => fieldDisplayName(v.field)).join(", ")
      fanoutNotice = `${names} is counted once per ${(role ? roleDisplayName(role) : "joined row").toLowerCase().replace(/s$/, "")}, not once per ${baseGrain.toLowerCase()} — totals are higher than the ${baseGrain.toLowerCase()} totals.`
    }
  } else {
    // A one-to-many role reached through a parent puts each record under every person it names.
    const many = [...fields.rows, ...fields.columns].map((it) => PERSON_ROLES[chipRoles[it.id] ?? ""]).find((r) => r?.idsKey)
    const numbers = fields.values.filter((v) => isNumericType(getFieldType(v.field)) && fieldKeyModule(v.field) !== "People")
    if (many && numbers.length > 0) {
      const names = numbers.map((v) => fieldDisplayName(v.field)).join(", ")
      fanoutNotice = `${names} repeats under each of the ${roleDisplayName(many.id).toLowerCase()}, so a ${baseGrain.toLowerCase()} appears under every member. Totals count each ${baseGrain.toLowerCase()} once.`
    }
  }
  const allRows: Row[] = MODULE_ROWS[grainModule] ?? []
  const roledRules = withFilterRoles(baseGrain, allRules, source)
  const filteredRows = allRows.filter((row) => rowPassesFilters(grainModule, row, roledRules))

  // Timeline: a filter (the report's, a viewer's, or both) and/or a Timeline in Rows or Columns.
  // None of them partitions records — a Timeline row or column is a set of date windows applied
  // to each time-tracked metric — so it is kept out of the labelers below. Which metrics it
  // governs is the report's call: exemptions live on the report's own Timeline filter.
  const tlRule = filterRules.find((r) => r.field === TIMELINE_KEY)
  const tlWindow = combinedTimelineWindow(filterRules, viewFilterRules)
  const tlCol = fields.columns.find((c) => c.field === TIMELINE_KEY)
  const tlRow = fields.rows.find((c) => c.field === TIMELINE_KEY)
  const tlRowAt = fields.rows.findIndex((c) => c.field === TIMELINE_KEY)
  const baseColumns = fields.columns.filter((c) => c.field !== TIMELINE_KEY)
  const baseRowFields = fields.rows.filter((c) => c.field !== TIMELINE_KEY)
  const follows = (item: PivotItem) => followsTimeline(item, tlRule)
  // A Timeline with nothing to split would only produce empty periods; it stands aside and a
  // notice says why.
  const canSplit = fields.values.some(follows)
  const tlActive = !!tlCol && canSplit
  const tlRowActive = !!tlRow && canSplit
  // The window a following metric is narrowed to before any column split: the Timeline filter's
  // period once one is picked, otherwise the metric's own calendar.
  const outerWindow = (item: PivotItem): DateWindow | null =>
    tlWindow ?? metricFilterWindow(timelineFilters[item.id])

  const labelWindow = (item: PivotItem) => (follows(item) ? tlWindow : null)
  const rowLabelers = baseRowFields.map((item) => buildLabeler(grainModule, filteredRows, item, aggregations, rangeConfigs, lookupPaths, labelWindow(item)))
  // Every Columns field participates. Each distinct combination gets one composite key (joined
  // for map-lookup purposes) but keeps its per-field label tuple around too (colLabelParts), so
  // the header can render true nested tiers — one row per Columns field, colSpan-grouped by
  // shared prefix — instead of flattening into a single joined label.
  const colLabelers = baseColumns.map((item) => buildLabeler(grainModule, filteredRows, item, aggregations, rangeConfigs, lookupPaths, labelWindow(item)))

  const SEP = "␟"
  const comboMap = new Map<string, { combo: string[]; sortTuple: (number | string)[]; cols: Map<string, Row[]> }>()
  const colLabelSort = new Map<string, (number | string)[]>()
  const colLabelParts = new Map<string, string[]>()

  // A multi-value field in Rows or Columns puts a record in every group it has a value for, so the
  // same record can sit in several cells — and totals must then count it once, not once per cell.
  const splitsRecords = [...rowLabelers, ...colLabelers].some((l) => !!l.labels)
  filteredRows.forEach((row) => {
    const colCombos = labelCombos(colLabelers, row)
    labelCombos(rowLabelers, row).forEach(({ labels: combo, sortKeys: sortTuple }) => {
      const comboKey = combo.join(SEP)
      if (!comboMap.has(comboKey)) comboMap.set(comboKey, { combo, sortTuple, cols: new Map() })
      const entry = comboMap.get(comboKey)!
      colCombos.forEach(({ labels: colParts, sortKeys: colSort }) => {
        const colLabel = colParts.join(SEP)
        if (!entry.cols.has(colLabel)) entry.cols.set(colLabel, [])
        entry.cols.get(colLabel)!.push(row)
        if (colLabelers.length > 0 && !colLabelSort.has(colLabel)) {
          colLabelSort.set(colLabel, colSort)
          colLabelParts.set(colLabel, colParts)
        }
      })
    })
  })

  const compareKey = (a: number | string, b: number | string) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))

  const sortedEntries = [...comboMap.values()].sort((a, b) => {
    for (let i = 0; i < a.sortTuple.length; i++) {
      const c = compareKey(a.sortTuple[i], b.sortTuple[i])
      if (c !== 0) return c
    }
    return 0
  })
  const groupLevelRules = roledRules.filter(isGroupLevelFilterRule)
  const comboEntries = groupLevelRules.length > 0
    ? applyGroupLevelFilters(sortedEntries, groupLevelRules, grainModule)
    : sortedEntries

  const notices: string[] = [...roleNotices]
  const notice = (n: string) => { if (!notices.includes(n)) notices.push(n) }
  if ((tlCol || tlRow) && !canSplit) notice("Timeline splits only time-tracked metrics, and none are in Values.")
  // A Timeline split lays out one slot per period. Measures it doesn't split (no date of their own,
  // or exempted) are ordinary values shown once, in a leading slot with no period label — never
  // repeated under each period, never only in a total.
  type TimelineSlot = { label: string; window: [number, number] | null; unsplit?: boolean }
  const unsplitIdx = fields.values.map((_, vi) => vi).filter((vi) => !follows(fields.values[vi]))
  const splitIdx = fields.values.map((_, vi) => vi).filter((vi) => follows(fields.values[vi]))
  const withUnsplitSlot = (periods: TimelineSlot[]): TimelineSlot[] =>
    unsplitIdx.length > 0 ? [{ label: "", window: null, unsplit: true }, ...periods] : periods

  const tlItem = tlCol ?? tlRow
  const tlGran = (tlItem && aggregations[tlItem.id]) || "Month & Year"
  const splitItems = fields.values.filter(follows)
  // The periods these rows have records in, for the measures the Timeline splits — each read from
  // its own date and kept inside its own window (the Timeline filter, or the chip's calendar).
  // Like grouping on a real date: a period exists only where something happened in it.
  const periodStartsOf = (rows: Row[]): Set<number> => {
    const out = new Set<number>()
    splitItems.forEach((item) => {
      const w = outerWindow(item)
      rows.forEach((row) => metricRecordTimes(grainModule, row, item.field).forEach((t) => {
        if (!w || w(t)) out.add(periodStart(new Date(t), tlGran).getTime())
      }))
    })
    return out
  }
  const entryRows = (entry: ComboEntry): Row[] => ([] as Row[]).concat(...entry.cols.values())
  // Every period any group has, in order — the columns of a Timeline in Columns, and the order of
  // the period rows of one in Rows.
  const timelineSplit = (): TimelineSlot[] => {
    const starts = new Set<number>()
    comboEntries.forEach((e) => periodStartsOf(entryRows(e)).forEach((t) => starts.add(t)))
    let periods = [...starts].sort((a, b) => a - b).map((t) => periodOf(t, tlGran))
    if (periods.length > TIMELINE_MAX_PERIODS) {
      periods = periods.slice(-TIMELINE_MAX_PERIODS)
      notice(`Showing the latest ${TIMELINE_MAX_PERIODS} periods — add a Timeline filter to choose the range.`)
    }
    return periods
  }

  // Each displayed row is a base group (the non-Timeline Rows fields) plus, with a Timeline in
  // Rows, one period's window — only the periods that group has records in. A group with none
  // still keeps one row, so "all projects" stays all of them.
  type DisplayRow = { entry: ComboEntry; ei: number; combo: string[]; window: DateWindow | null; unsplit?: boolean }
  let rowsOut: DisplayRow[] = comboEntries.map((entry, ei) => ({ entry, ei, combo: entry.combo, window: null }))
  if (tlRow) {
    const periods: TimelineSlot[] =
      tlRowActive ? withUnsplitSlot(timelineSplit()) : [{ label: "All time", window: null }]
    // Groups sharing the Rows fields before the Timeline nest the period inside them, then any
    // fields after it — so order by that shared prefix, then period, then the rest.
    let prefixGroup = -1, prevPrefix: string | null = null
    const keyed: (DisplayRow & { pg: number; pi: number })[] = []
    comboEntries.forEach((entry, ei) => {
      const prefix = entry.combo.slice(0, tlRowAt).join(SEP)
      if (prefix !== prevPrefix) { prefixGroup++; prevPrefix = prefix }
      const own = tlRowActive ? periodStartsOf(entryRows(entry)) : null
      const slots = periods.map((p, pi) => ({ p, pi })).filter(({ p }) => !own || !p.window || own.has(p.window[0]))
      if (slots.length === 0) slots.push({ p: { label: "", window: null, unsplit: true }, pi: -1 })
      slots.forEach(({ p, pi }) => {
        const combo = [...entry.combo]
        combo.splice(tlRowAt, 0, p.label)
        keyed.push({ entry, ei, combo, window: p.window ? spanWindow(p.window) : null, unsplit: p.unsplit, pg: prefixGroup, pi })
      })
    })
    keyed.sort((a, b) => a.pg - b.pg || a.pi - b.pi || a.ei - b.ei)
    rowsOut = keyed
  }
  rowsOut = rowsOut.slice(0, 200)
  const displayRows = rowsOut.map((r) => r.combo)

  let colValues = colLabelers.length > 0
    ? [...colLabelSort.entries()].sort((a, b) => {
        for (let i = 0; i < a[1].length; i++) {
          const c = compareKey(a[1][i], b[1][i])
          if (c !== 0) return c
        }
        return 0
      }).map(([label]) => label).slice(0, 8)
    : []
  // Per-field label tuple for each entry in colValues, same order/index — lets the header
  // render true nested tiers (one row per Columns field) instead of colValues' joined key.
  let colTuples = colValues.map((label) => colLabelParts.get(label) ?? [])

  // Each displayed column is a base combination (the non-Timeline Columns fields) plus, when a
  // Timeline column is present, one period's date window.
  let colBase: string[] = colValues
  let colWindow: (DateWindow | null)[] = colValues.map(() => null)
  let colUnsplit: boolean[] = colValues.map(() => false)
  if (tlCol && tlActive) {
    const periods = withUnsplitSlot(timelineSplit())
    const bases = baseColumns.length > 0 ? colValues : [""]
    const tlAt = fields.columns.findIndex((c) => c.field === TIMELINE_KEY)
    const outer = tlAt === 0 && baseColumns.length > 0 ? "period" : "base"
    const nextValues: string[] = [], nextTuples: string[][] = [], nextBase: string[] = []
    const nextWindow: (DateWindow | null)[] = [], nextUnsplit: boolean[] = []
    const push = (b: string, p: TimelineSlot) => {
      const parts = [...(colLabelParts.get(b) ?? [])]
      parts.splice(Math.min(tlAt, parts.length), 0, p.label)
      nextValues.push(parts.join(SEP)); nextTuples.push(parts); nextBase.push(b)
      nextWindow.push(p.window ? spanWindow(p.window) : null); nextUnsplit.push(!!p.unsplit)
    }
    if (outer === "period") periods.forEach((p) => bases.forEach((b) => push(b, p)))
    else bases.forEach((b) => periods.forEach((p) => push(b, p)))
    colValues = nextValues; colTuples = nextTuples; colBase = nextBase; colWindow = nextWindow
    colUnsplit = nextUnsplit
  }
  // The measures each column shows: all of them, except under a Timeline column — the leading
  // slot holds the ones it doesn't split, every period the ones it does.
  const colItems = colValues.map((_, ci) =>
    !tlActive ? fields.values.map((_, vi) => vi) : colUnsplit[ci] ? unsplitIdx : splitIdx)

  const hasColumns = colValues.length > 0
  const hasValues = fields.values.length > 0

  const bucketRows = (ri: number, ci: number): Row[] => {
    const entry = rowsOut[ri]?.entry
    const colLabel = hasColumns ? colBase[ci] : ""
    return entry ? (entry.cols.get(colLabel) ?? []) : []
  }

  const aggOf = (item: PivotItem) => {
    const type = getFieldType(item.field)
    return { type, agg: aggregations[item.id] || (isNumericType(type) ? "Sum" : "Count") }
  }

  // Is this measure shown at this row and column? Under a Timeline split, a measure it doesn't
  // split lives only in the leading slot, and one it does only in the periods.
  const shown = (ri: number, ci: number, vi: number): boolean => {
    if (!tlActive && !tlRowActive) return true
    const inUnsplitSlot = tlActive ? !!colUnsplit[ci] : !!rowsOut[ri]?.unsplit
    return follows(fields.values[vi]) ? !inUnsplitSlot : inUnsplitSlot
  }

  const cellNum = (ri: number, ci: number, vi: number): number => {
    const item = fields.values[vi]
    if (!item) return 0
    // NaN renders blank, and the totals below skip it.
    if (!shown(ri, ci, vi)) return NaN
    if (isFormulaKey(item.field)) {
      const def = formulaOf(item.field)
      return def ? formulaOverRows(def, bucketRows(ri, ci), grainModule) : NaN
    }
    const { type, agg } = aggOf(item)
    const rows = bucketRows(ri, ci)
    if ((tlActive || tlRowActive) && follows(item)) {
      const w = intersectWindows(intersectWindows(colWindow[ci] ?? null, rowsOut[ri]?.window ?? null), outerWindow(item))
      // Nothing recorded here in this period: blank, not a zero that reads as a real figure.
      const recorded = rows.some((row) => metricRecordTimes(grainModule, row, item.field).some((t) => !w || w(t)))
      if (!recorded) return NaN
      return aggregateBucket(rows, grainModule, item, agg, type, undefined, lookupPaths[item.id], w)
    }
    if (tlWindow && follows(item)) {
      return aggregateBucket(rows, grainModule, item, agg, type, undefined, lookupPaths[item.id], tlWindow)
    }
    return aggregateBucket(rows, grainModule, item, agg, type, timelineFilters[item.id], lookupPaths[item.id])
  }

  // Totals over a group of displayed rows — a subtotal, a row's total, the grand total: the sum of
  // the cells it covers that show the measure, blank only if none do. Each measure appears once
  // per record, so nothing is counted twice.
  const sumShown = (vals: number[]): number => {
    let any = vals.length === 0, sum = 0
    vals.forEach((v) => { if (!Number.isNaN(v)) { any = true; sum += v } })
    return any ? sum : NaN
  }
  const allCols = hasColumns ? colValues.map((_, ci) => ci) : [0]
  // When records were split across groups, a total is the measure over the distinct records it
  // covers — the same submission under two options adds to the total once.
  const distinctTotal = (cells: [number, number][], vi: number): number => {
    const item = fields.values[vi]
    if (!item) return 0
    const rows = [...new Set(cells.flatMap(([ri, ci]) => bucketRows(ri, ci)))]
    const { type, agg } = aggOf(item)
    if (tlWindow && follows(item)) return aggregateBucket(rows, grainModule, item, agg, type, undefined, lookupPaths[item.id], tlWindow)
    return aggregateBucket(rows, grainModule, item, agg, type, timelineFilters[item.id], lookupPaths[item.id])
  }
  // The same holds for any measure that doesn't add up: the total of a distinct count, an average,
  // a min or a max is that measure over the records, never the sum of the cells.
  const NON_ADDITIVE = ["Distinct Count", "Average", "Min", "Max"]
  const distinctTotals = (vi: number) => !tlActive && !tlRowActive
    && (splitsRecords || (!!fields.values[vi] && NON_ADDITIVE.includes(aggOf(fields.values[vi]).agg)))
  // A formula's total is the formula over its fields' totals, never the sum of its cells.
  const formulaTotal = (cells: [number, number][], vi: number): number => {
    const def = formulaOf(fields.values[vi].field)
    if (!def) return NaN
    return formulaOverRows(def, [...new Set(cells.flatMap(([ri, ci]) => bucketRows(ri, ci)))], grainModule)
  }
  const isFormulaAt = (vi: number) => !!fields.values[vi] && isFormulaKey(fields.values[vi].field)
  const groupCell = (leaves: number[], ci: number, vi: number): number =>
    isFormulaAt(vi) ? formulaTotal(leaves.map((ri) => [ri, ci]), vi)
    : distinctTotals(vi)
      ? distinctTotal(leaves.map((ri) => [ri, ci]), vi)
      : sumShown(leaves.map((ri) => cellNum(ri, ci, vi)))
  const groupTotal = (leaves: number[], vi: number): number =>
    isFormulaAt(vi) ? formulaTotal(leaves.flatMap((ri) => allCols.map((ci): [number, number] => [ri, ci])), vi)
    : distinctTotals(vi)
      ? distinctTotal(leaves.flatMap((ri) => allCols.map((ci): [number, number] => [ri, ci])), vi)
      : sumShown(leaves.flatMap((ri) => allCols.map((ci) => cellNum(ri, ci, vi))))
  const rowTotal = (ri: number, vi: number): number => groupTotal([ri], vi)

  const allLeaves = displayRows.map((_, ri) => ri)
  const grandTotals = fields.values.map((_, vi) => groupTotal(allLeaves, vi))


  return {
    displayRows, colValues, colTuples, colItems, hasColumns, hasValues, cellNum, rowTotal, groupCell, groupTotal, grandTotals, bucketRows, grainModule,
    fanoutNotice, timelineNotices: notices,
  }
}

// Groups a sorted list of column-label tuples into per-level colSpan runs for nested pivot
// headers — level 0 is the outermost tier (the first Columns field), the last level is
// innermost. Relies on colTuples already being sorted so shared prefixes are contiguous
// (guaranteed by computeReportData's composite sort over the same field order).
function buildColumnHeaderTiers(colTuples: string[][]): { label: string; span: number }[][] {
  const numLevels = colTuples[0]?.length ?? 0
  const tiers: { label: string; span: number }[][] = []
  for (let level = 0; level < numLevels; level++) {
    const row: { label: string; span: number }[] = []
    let i = 0
    while (i < colTuples.length) {
      let j = i + 1
      while (j < colTuples.length && colTuples[j].slice(0, level + 1).every((v, idx) => v === colTuples[i][idx])) j++
      row.push({ label: colTuples[i][level], span: j - i })
      i = j
    }
    tiers.push(row)
  }
  return tiers
}

// ── Tabular report computation ────────────────────────────────────────────────────

// Several helpers built for the pivot builder (pickGrain, FieldBrowser, relevantFieldValues,
// allAddedFields) take a PivotFields and only ever READ the union of its three arrays. Rather
// than widen all of their signatures — and risk the working pivot path — a tabular report
// presents itself as one: its columns and its group-by fields, with an empty values shelf.
function asPivotFields(f: TabularFields): PivotFields {
  return { columns: f.columns, rows: f.groupBy, values: [] }
}

const TABULAR_ROW_CAP = 500

interface TabularCell { raw: any; text: string }
interface TabularRow { groupLabels: string[]; cells: TabularCell[] }
interface ComputedTabular {
  grainModule: string
  rows: TabularRow[]
  totalCount: number   // before the display cap, so the UI can say "showing X of N"
}

// One row per record at the report's grain. Group-by fields are labelled with the SAME
// buildLabeler the pivot uses for row grouping, so date granularity and numeric Range banding
// behave identically in both builders.
function computeTabularData(
  source: string,
  fields: TabularFields,
  groupByAggregations: Record<string, string>,
  filterRules: FilterRule[],
  viewFilterRules: FilterRule[],
  rangeConfigs: Record<string, RangeConfig>,
  fieldFormats: Record<string, FieldFormat>,
  groupSortDir: "asc" | "desc",
  showProjectCurrency: boolean,
  lookupPaths: Record<string, string> = {},
): ComputedTabular {
  // Base filters scope the report; view filters run on top — same ordering as computeReportData.
  const allRules = viewFilterRules.length > 0 ? [...filterRules, ...viewFilterRules] : filterRules
  const pivotShape = asPivotFields(fields)
  const grainModule = pickGrainWithRoles(source, pivotShape, allRules, lookupPaths)
  const chipRoles = resolveChipRoles(pickGrain(source, pivotShape, allRules), pivotShape, lookupPaths, source)
  lookupPaths = chipRoles
  const allRows: Row[] = MODULE_ROWS[grainModule] ?? []
  const filtered = filterRowsFlat(grainModule, allRows, withFilterRoles(pickGrain(source, pivotShape, allRules), allRules, source))

  // The Timeline filter narrows each included time-tracked field to its period — the columns and
  // anything grouped on; every other field, and the list of records itself, is untouched.
  const tlRule = filterRules.find((r) => r.field === TIMELINE_KEY)
  const tlWindow = combinedTimelineWindow(filterRules, viewFilterRules)
  const tlWindowFor = (item: PivotItem) => (tlWindow && followsTimeline(item, tlRule) ? tlWindow : null)

  const groupLabelers = fields.groupBy.map((item) =>
    buildLabeler(grainModule, filtered, item, groupByAggregations, rangeConfigs, lookupPaths, tlWindowFor(item)))

  const compareKey = (a: number | string, b: number | string) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))

  // Sort by the group tuple so rows sharing a group are contiguous — that contiguity is what
  // lets the renderer span a group's label cell down its rows.
  const decorated = filtered.map((row) => ({
    row,
    labels: groupLabelers.map((l) => l.label(row)),
    sortKeys: groupLabelers.map((l) => l.sortKey(row)),
  }))
  if (groupLabelers.length > 0) {
    const dir = groupSortDir === "desc" ? -1 : 1
    decorated.sort((a, b) => {
      for (let i = 0; i < a.sortKeys.length; i++) {
        const c = compareKey(a.sortKeys[i], b.sortKeys[i])
        if (c !== 0) return c * dir
      }
      return 0
    })
  }

  const rows: TabularRow[] = decorated.slice(0, TABULAR_ROW_CAP).map(({ row, labels }) => ({
    groupLabels: labels,
    cells: fields.columns.map((item) => {
      const raw = resolveFieldForRow(grainModule, row, item.field, tlWindowFor(item), lookupPaths[item.id])
      let text = tabularCellText(raw, item, fieldFormats)
      // Simpler than the pivot's version of this setting: a tabular row IS one record, so its
      // currency is unambiguous — no mixed-currency group to suppress the tag for.
      if (showProjectCurrency && text !== "" && getFieldType(item.field) === "money") {
        const cur = resolveFieldForRow(grainModule, row, "Project::Project currency", null)
        if (cur != null && cur !== "") text += ` ${cur}`
      }
      return { raw, text }
    }),
  }))

  return { grainModule, rows, totalCount: decorated.length }
}

// formatCellValue only knows numbers, and a flat table shows dates, text and booleans too —
// so non-numeric values get sensible plain rendering and skip the numeric formatter entirely.
function tabularCellText(raw: any, item: PivotItem, fieldFormats: Record<string, FieldFormat>): string {
  if (Array.isArray(raw)) return raw.join(", ")
  if (raw == null || raw === "") return ""
  const type = getFieldType(item.field)
  if (isNumericType(type)) {
    const n = Number(raw)
    return Number.isNaN(n) ? String(raw) : formatCellValue(n, fieldFormats[item.id])
  }
  if (type === "boolean") return raw ? "Yes" : "No"
  if (type === "date") {
    const d = raw instanceof Date ? raw : new Date(raw)
    return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString().slice(0, 10)
  }
  return String(raw)
}

// A numeric view filter in a flat report slides over the records' own values, not over
// per-group aggregates — the flat counterpart to previewGroupAggregates. Mirrors
// relevantFieldValues' shape: grain from all rules, narrowing from the base rules only.
function flatFieldNumericValues(
  source: string, fields: PivotFields, grainRules: FilterRule[], scopeRules: FilterRule[], fieldKey: string,
): number[] {
  const grainModule = pickGrain(source, fields, grainRules)
  const out: number[] = []
  filterRowsFlat(grainModule, MODULE_ROWS[grainModule] ?? [], withFilterRoles(grainModule, scopeRules, source)).forEach((row) => {
    const n = Number(resolveFieldForRow(grainModule, row, fieldKey, null))
    if (!Number.isNaN(n)) out.push(n)
  })
  return out
}


// ── Left nav ───────────────────────────────────────────────────────────────────

// Stands in for the signed-in user. A "current user" filter is only believable if you can watch
// it answer differently for two people, and one browser has one session — so the avatar switches
// who is looking.
function ViewerSwitcher({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = getCurrentUserName()
  const initials = current.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((p) => !p)}
        title={`Viewing as ${current} — click to switch`}
        className="w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center cursor-pointer mt-1
          hover:ring-2 hover:ring-emerald-300 transition-all"
      >
        <span className="text-white text-[9px] font-bold">{initials}</span>
      </button>
      {open && (
        <ChipPortalMenu anchorRef={btnRef} onClose={() => setOpen(false)}>
          <div className="bg-white border border-gray-200 rounded-lg shadow-2xl py-1 w-56 max-h-[320px] overflow-y-auto">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pt-2 pb-1">Viewing as</p>
            {PERSON_NAMES.map((name) => (
              <button
                key={name}
                onClick={() => { setCurrentUserName(name); setOpen(false); onChange() }}
                className={`flex items-center justify-between w-full px-3 py-1.5 text-[13px] text-left hover:bg-indigo-50 transition-colors
                  ${name === current ? "text-indigo-600 font-medium" : "text-gray-700"}`}
              >
                {name}
                {name === current && <Ic.Check />}
              </button>
            ))}
          </div>
        </ChipPortalMenu>
      )}
    </>
  )
}

function LeftNav({ appMode, setAppMode, onViewerChange }: { appMode: string; setAppMode: (m: AppMode) => void; onViewerChange: () => void }) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <nav className="flex flex-col items-center w-12 min-h-screen bg-white border-r border-gray-200 py-2 gap-0.5 shrink-0 relative z-30">
      <div className="w-8 h-8 rounded-lg overflow-hidden mb-2.5">
        <div className="w-full h-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
          <span className="text-white text-[9px] font-bold tracking-tight">RL</span>
        </div>
      </div>
      <NavBtn label="Search" nav><Ic.Search /></NavBtn>
      <NavBtn label="Notifications" nav><Ic.Bell /></NavBtn>
      <NavBtn label="Home" nav><Ic.Home /></NavBtn>
      <NavBtn label="Projects" nav><Ic.Folder /></NavBtn>

      {/* Analytics nav item with mode switcher */}
      <div className="relative">
        <button
          title="Analytics"
          onClick={() => setShowMenu(p => !p)}
          className="w-8 h-8 rounded-md flex items-center justify-center transition-colors bg-indigo-100 text-indigo-600"
        >
          <Ic.BarChart />
        </button>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div className="absolute left-full top-0 ml-2 z-50 bg-gray-900 text-white rounded-xl shadow-2xl py-2 w-52 overflow-hidden">
              <button
                onClick={() => { setAppMode("dashboard"); setShowMenu(false) }}
                className={`flex items-center gap-3 w-full px-4 py-3 text-[14px] transition-colors hover:bg-white/10
                  ${appMode === "dashboard" ? "text-white font-semibold" : "text-gray-200"}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                  <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                Dashboard
                {appMode === "dashboard" && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400" />}
              </button>
              <button
                onClick={() => { setAppMode("reports"); setShowMenu(false) }}
                className={`flex items-center gap-3 w-full px-4 py-3 text-[14px] transition-colors hover:bg-white/10
                  ${appMode === "reports" ? "text-white font-semibold" : "text-gray-200"}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
                Reports
                {appMode === "reports" && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400" />}
              </button>
              <button
                onClick={() => { setAppMode("tabular"); setShowMenu(false) }}
                className={`flex items-center gap-3 w-full px-4 py-3 text-[14px] transition-colors hover:bg-white/10
                  ${appMode === "tabular" ? "text-white font-semibold" : "text-gray-200"}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M10 9v12"/>
                </svg>
                Tabular
                {appMode === "tabular" && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400" />}
              </button>
            </div>
          </>
        )}
      </div>

      <NavBtn label="Tables" nav><Ic.Grid /></NavBtn>
      <NavBtn label="Tasks" nav><Ic.List /></NavBtn>
      <NavBtn label="People" nav><Ic.Users /></NavBtn>
      <NavBtn label="Apps" nav><Ic.Apps /></NavBtn>
      <NavBtn label="AI" nav><Ic.Sparkle /></NavBtn>
      <div className="mt-auto flex flex-col items-center gap-0.5">
        <NavBtn label="Gifts" nav><Ic.Gift /></NavBtn>
        <NavBtn label="Messages" nav><Ic.Message /></NavBtn>
        <ViewerSwitcher onChange={onViewerChange} />
      </div>
    </nav>
  )
}

// ── Export ─────────────────────────────────────────────────────────────────────

// Serializes the rendered report table to a grid, honouring colSpan/rowSpan so nested column
// tiers and Detail view's spanning row labels land in the right cells. Reading the DOM rather
// than re-deriving from computeReportData is deliberate: the export then matches exactly what
// the user is looking at — same layout, same formatting, same totals — with no second
// implementation to drift.
// ── Export ─────────────────────────────────────────────────────────────────────
// Both exports read the rendered table rather than recomputing the report, so whatever is on
// screen — filters, view, formatting, layout — is what lands in the file, with nothing to keep
// in sync. Numeric cells are tagged in the DOM by the canvas's `tabular-nums` class, which is
// the signal the xlsx writer uses to decide what becomes a real number.

interface GridCell { text: string; numeric: boolean; raw: number | null }

// innerText runs adjacent inline children together, so a value header built from an aggregation
// badge and a field label reads "SumProject Fee". The badge is spaced with a margin rather than a
// real space, which is right for the screen and wrong for a file — so the parts are joined here
// instead of changing the markup.
function cellExportText(cell: HTMLTableCellElement): string {
  const parts: string[] = []
  cell.childNodes.forEach((node) => {
    const text = (node.textContent || "").replace(/\s+/g, " ").trim()
    if (text !== "") parts.push(text)
  })
  return parts.join(" ")
}

function reportTableToGrid(table: HTMLTableElement): GridCell[][] {
  const grid: GridCell[][] = []
  Array.from(table.rows).forEach((tr, r) => {
    if (!grid[r]) grid[r] = []
    let c = 0
    Array.from(tr.cells).forEach((cell) => {
      while (grid[r][c] !== undefined) c++
      const text = cellExportText(cell)
      const numeric = cell.classList.contains("tabular-nums")
      // data-v is the cell's unrounded value, set by the canvas either on the cell itself or on
      // the span wrapping its formatted number. Without it (the row-number gutter, say) the
      // displayed text is parsed instead.
      const carried = cell.dataset.v ?? cell.querySelector<HTMLElement>("[data-v]")?.dataset.v
      const raw = carried !== undefined && carried !== "" ? Number(carried) : null
      for (let i = 0; i < cell.rowSpan; i++) {
        for (let j = 0; j < cell.colSpan; j++) {
          if (!grid[r + i]) grid[r + i] = []
          // Only the origin cell carries the text; the cells it spans stay blank so columns
          // still line up in a spreadsheet.
          grid[r + i][c + j] = i === 0 && j === 0
            ? { text, numeric, raw: raw !== null && Number.isFinite(raw) ? raw : null }
            : { text: "", numeric: false, raw: null }
        }
      }
      c += cell.colSpan
    })
  })
  return grid.map((row) => Array.from(row, (v) => v ?? { text: "", numeric: false, raw: null }))
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const exportStamp = () => new Date().toISOString().slice(0, 10)

function exportReportCsv(): boolean {
  const table = document.querySelector<HTMLTableElement>("[data-report-table]")
  if (!table) return false
  const csv = reportTableToGrid(table)
    .map((row) => row.map((cell) => csvEscape(cell.text)).join(","))
    .join("\r\n")
  // BOM so Excel opens UTF-8 correctly instead of mangling accented names.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
  downloadBlob(blob, `custom-report-${exportStamp()}.csv`)
  return true
}

// The inverse of the app's own number formatting. A spreadsheet's whole point is that you can
// sum and chart a column, so "135.7k" is written back out as the number 135700 rather than as
// text. Applied only to cells the canvas marked numeric, and any cell whose shape isn't
// recognised falls through to text — the safe direction, since that is what CSV does anyway.
const DISPLAY_UNIT_MULTIPLIER: Record<string, number> = {
  k: 1_000, K: 1_000,      // thousands
  L: 100_000,              // lakhs
  m: 1_000_000, M: 1_000_000,
  C: 10_000_000,           // crores
  B: 1_000_000_000,
}

function parseDisplayNumber(text: string): number | null {
  let t = text.trim()
  if (t === "") return null
  let sign = 1
  if (/^\(.+\)$/.test(t)) { sign = -1; t = t.slice(1, -1).trim() }   // accounting negatives
  t = t.replace(/\s+[A-Za-z]{3}$/, "").trim()                        // trailing currency code
  const m = /^[^\d+-]*(-?[\d,\s]*\.?\d+)([kKLmMCB]?)$/.exec(t)
  if (!m) return null
  const digits = m[1].replace(/[,\s]/g, "")
  if (!/^-?\d*\.?\d+$/.test(digits)) return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  return sign * n * (m[2] ? DISPLAY_UNIT_MULTIPLIER[m[2]] : 1)
}

// ── Minimal .xlsx writer ───────────────────────────────────────────────────────
// An .xlsx is a ZIP of XML parts. Writing both by hand keeps the app dependency-free — a
// spreadsheet library would be several times the size of the whole bundle — and one flat sheet
// needs very little of the format. Entries are STOREd rather than deflated, which every ZIP
// reader is required to support, so no compressor is needed either.

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zipStore(entries: { name: string; bytes: Uint8Array }[]): Blob {
  const enc = new TextEncoder()
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff]
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
  // A fixed 1980-01-01 timestamp: zero is not a legal DOS date, and a real clock would only
  // make byte-identical exports differ.
  const DOS_TIME = 0, DOS_DATE = 33

  const body: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  entries.forEach(({ name, bytes }) => {
    const nameBytes = enc.encode(name)
    const crc = crc32(bytes)
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ])
    body.push(local, bytes)
    central.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]))
    offset += local.length + bytes.length
  })

  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const end = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ])

  const parts = [...body, ...central, end]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  parts.forEach((p) => { out.set(p, at); at += p.length })
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&apos;")
}

// A1, B1 … Z1, AA1 — spreadsheet column letters.
function colRef(index: number): string {
  let ref = ""
  let n = index
  while (n >= 0) {
    ref = String.fromCharCode(65 + (n % 26)) + ref
    n = Math.floor(n / 26) - 1
  }
  return ref
}

function exportReportXlsx(): boolean {
  const table = document.querySelector<HTMLTableElement>("[data-report-table]")
  if (!table) return false
  const grid = reportTableToGrid(table)
  if (grid.length === 0) return false
  const headerRows = table.tHead?.rows.length ?? 1
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0)

  const rowsXml = grid.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell.text === "") return ""
      const ref = `${colRef(c)}${r + 1}`
      const style = r < headerRows ? ' s="1"' : ""
      const num = cell.raw ?? (cell.numeric ? parseDisplayNumber(cell.text) : null)
      return num !== null
        ? `<c r="${ref}"${style}><v>${num}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t>${xmlEscape(cell.text)}</t></is></c>`
    }).join("")
    return `<row r="${r + 1}">${cells}</row>`
  }).join("")

  // Widths sized to the longest cell in each column, so the sheet is readable on open rather
  // than a wall of ####.
  const cols = Array.from({ length: width }, (_, c) => {
    const longest = grid.reduce((max, row) => Math.max(max, row[c]?.text.length ?? 0), 0)
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(48, Math.max(10, longest + 3))}" customWidth="1"/>`
  }).join("")

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="${headerRows}" topLeftCell="A${headerRows + 1}" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${rowsXml}</sheetData></worksheet>`

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    // Excel requires fill 0 = none and fill 1 = gray125 before any custom fill.
    `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `</styleSheet>`

  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  const enc = new TextEncoder()
  const blob = zipStore([
    { name: "[Content_Types].xml", bytes: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`) },
    { name: "_rels/.rels", bytes: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`) },
    { name: "xl/workbook.xml", bytes: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}">` +
      `<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", bytes: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/>` +
      `</Relationships>`) },
    { name: "xl/styles.xml", bytes: enc.encode(styles) },
    { name: "xl/worksheets/sheet1.xml", bytes: enc.encode(sheet) },
  ])
  downloadBlob(blob, `custom-report-${exportStamp()}.xlsx`)
  return true
}

function NavBtn({ children, label, active = false, nav = false }: {
  children: React.ReactNode; label: string; active?: boolean; nav?: boolean
}) {
  void nav
  return (
    <button
      title={label}
      className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors
        ${active ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
    >
      {children}
    </button>
  )
}

// ── Page header ────────────────────────────────────────────────────────────────

// ── Saved views ────────────────────────────────────────────────────────────────

type ViewAudience = "me" | "specific" | "all"

// A saved view is a child version of its report. The parent owns the source, fields, filters,
// formatting and which fields sit on the view-filter rail; the view owns one configuration of
// that rail. Storing only the rail's rules is what lets a view stay valid as its parent evolves —
// applying one reconciles against the report's current rail rather than overwriting it.
interface SavedView {
  id: string
  name: string
  audience: ViewAudience
  members: string[]
  rules: FilterRule[]
}

const nextSavedViewId = () => `view-${Math.random().toString(36).slice(2, 10)}`

const AUDIENCE_LABEL: Record<ViewAudience, string> = {
  me: "Only me",
  specific: "Specific team members",
  all: "All team members",
}

function useSavedViews(
  storageKey: string,
  reportMode: ReportMode,
  viewFilterRules: FilterRule[],
  setViewFilterRules: (rules: FilterRule[]) => void,
) {
  const [views, setViews] = useState<SavedView[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? migrateFieldKeys(JSON.parse(raw) as SavedView[]) : []
    } catch {
      return []
    }
  })
  const [activeId, setActiveId] = useState<string | null>(null)
  // The report's own rail setup, captured when view mode is entered. It is what Default View
  // shows, and what edit mode gets handed back — a viewer's tweaks belong to the view layer, not
  // to the report definition, so they must not follow the user back into the builder.
  const reportRules = useRef<FilterRule[]>(viewFilterRules)
  // What the active view currently stands for. The rail is "changed" relative to this.
  const [baseline, setBaseline] = useState<FilterRule[]>(viewFilterRules)

  const persist = (next: SavedView[]) => {
    setViews(next)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch {}
  }

  const prevMode = useRef(reportMode)
  useEffect(() => {
    if (prevMode.current === reportMode) return
    prevMode.current = reportMode
    if (reportMode === "view") {
      reportRules.current = viewFilterRules
      setBaseline(viewFilterRules)
      setActiveId(null)
    } else {
      setViewFilterRules(reportRules.current)
      setActiveId(null)
    }
  }, [reportMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a view's selections for fields still on the rail, and pick up any field added to the
  // report since the view was saved. Fields dropped from the rail fall away with it.
  const reconcile = (rules: FilterRule[]): FilterRule[] =>
    reportRules.current.map((r) => rules.find((s) => s.field === r.field) ?? r)

  const applyView = (id: string | null) => {
    const target = id === null ? reportRules.current : views.find((v) => v.id === id)?.rules
    const next = reconcile(target ?? reportRules.current)
    setViewFilterRules(next)
    setBaseline(next)
    setActiveId(id)
  }

  const saveView = (name: string, audience: ViewAudience, members: string[]) => {
    const view: SavedView = {
      id: nextSavedViewId(),
      name: name.trim(),
      audience,
      members: audience === "specific" ? members : [],
      rules: viewFilterRules,
    }
    persist([...views, view])
    setBaseline(viewFilterRules)
    setActiveId(view.id)
  }

  const deleteView = (id: string) => {
    persist(views.filter((v) => v.id !== id))
    if (activeId === id) {
      const next = reconcile(reportRules.current)
      setViewFilterRules(next)
      setBaseline(next)
      setActiveId(null)
    }
  }

  const resetView = () => setViewFilterRules(baseline)

  const activeView = views.find((v) => v.id === activeId) ?? null
  return {
    views,
    activeId,
    activeName: activeView?.name ?? "Default View",
    dirty: JSON.stringify(viewFilterRules) !== JSON.stringify(baseline),
    applyView,
    saveView,
    deleteView,
    resetView,
  }
}

// The view-mode toolbar: which view is showing, how many of its filters are set, and — once the
// rail has been touched — the two things you can do about it.
function SavedViewsBar({
  views, activeId, activeName, dirty, onPick, onSaveAs, onReset, onDelete,
}: {
  views: SavedView[]
  activeId: string | null
  activeName: string
  dirty: boolean
  onPick: (id: string | null) => void
  onSaveAs: () => void
  onReset: () => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={btnRef}
        onClick={() => setOpen((p) => !p)}
        title="Switch between saved views of this report"
        className={`flex items-center gap-1.5 text-[13px] border rounded-md px-2.5 py-1.5 transition-all font-medium
          ${open ? "text-indigo-600 border-indigo-300 bg-indigo-50" : "text-gray-700 border-gray-200 bg-white hover:bg-gray-50"}`}
      >
        <Ic.ViewDetail /><span>{activeName}</span><Ic.ChevDown size={10} />
      </button>
      {open && (
        <ChipPortalMenu anchorRef={btnRef} onClose={() => setOpen(false)}>
          <SavedViewsMenu
            views={views}
            activeId={activeId}
            onPick={(id) => { onPick(id); setOpen(false) }}
            onDelete={onDelete}
          />
        </ChipPortalMenu>
      )}

      {/* Only offered once the rail differs from the view on screen — with nothing changed there
          is no version to capture and nothing to discard. */}
      {dirty && (
        <>
          <button
            onClick={onSaveAs}
            title="Save view as…"
            className="flex items-center text-[13px] text-indigo-700 border border-indigo-300 bg-indigo-50
              rounded-md px-2.5 py-1.5 hover:bg-indigo-100 transition-colors"
          >
            <Ic.Save size={14} />
          </button>
          <button
            onClick={onReset}
            title={`Discard changes and go back to ${activeName}`}
            className="flex items-center text-[13px] text-gray-500 border border-gray-200 bg-white
              rounded-md px-2.5 py-1.5 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            <Ic.X />
          </button>
        </>
      )}
    </div>
  )
}

function SavedViewsMenu({ views, activeId, onPick, onDelete }: {
  views: SavedView[]
  activeId: string | null
  onPick: (id: string | null) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const match = (v: SavedView) => v.name.toLowerCase().includes(q)
  const mine = views.filter((v) => v.audience === "me" && match(v))
  const shared = views.filter((v) => v.audience !== "me" && match(v))

  const row = (view: SavedView) => (
    <div key={view.id} className="group flex items-center gap-2 pl-6 pr-2 py-1.5 hover:bg-indigo-50 transition-colors">
      <span className="text-gray-400 shrink-0">{view.audience === "me" ? <Ic.Person /> : <Ic.Users />}</span>
      <button onClick={() => onPick(view.id)} className="flex-1 min-w-0 text-left">
        <span className={`block text-[13px] truncate ${activeId === view.id ? "text-indigo-600 font-medium" : "text-gray-700"}`}>
          {view.name}
        </span>
        {view.audience === "specific" && view.members.length > 0 && (
          <span className="block text-[11px] text-gray-400 truncate">
            Shared with {view.members.length} {view.members.length === 1 ? "person" : "people"}
          </span>
        )}
      </button>
      {activeId === view.id && <span className="text-indigo-600 shrink-0"><Ic.Check /></span>}
      <button
        onClick={() => onDelete(view.id)}
        title={`Delete "${view.name}"`}
        className="shrink-0 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"
      >
        <Ic.Trash />
      </button>
    </div>
  )

  return (
    <div className="mt-1 bg-white border border-gray-200 rounded-xl shadow-2xl w-[280px] overflow-hidden">
      <p className="text-[14px] font-semibold text-gray-900 px-3 pt-3 pb-2">Saved views</p>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-2.5 py-1.5 focus-within:border-indigo-300">
          <span className="text-gray-400"><Ic.Search /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search view..."
            className="flex-1 min-w-0 text-[13px] outline-none placeholder:text-gray-400"
          />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto pb-2">
        {"default view".includes(q) && (
          <button
            onClick={() => onPick(null)}
            className={`flex items-center gap-2 w-full px-3 py-2 transition-colors
              ${activeId === null ? "bg-indigo-50 text-indigo-600 font-medium" : "text-gray-700 hover:bg-indigo-50"}`}
          >
            <Ic.Globe /><span className="flex-1 text-left text-[13px]">Default View</span>
            {activeId === null && <Ic.Check />}
          </button>
        )}

        <p className="flex items-center gap-2 text-[12px] font-medium text-gray-500 px-3 pt-3 pb-1">
          <Ic.Person /> My saved views
        </p>
        {mine.length > 0
          ? mine.map(row)
          : <p className="text-[12px] text-gray-400 pl-6 py-1.5">{q ? "No matches" : "No saved views"}</p>}

        <p className="flex items-center gap-2 text-[12px] font-medium text-gray-500 px-3 pt-3 pb-1">
          <Ic.Users /> Shared views
        </p>
        {shared.length > 0
          ? shared.map(row)
          : <p className="text-[12px] text-gray-400 pl-6 py-1.5">{q ? "No matches" : "No shared views"}</p>}
      </div>
    </div>
  )
}

function NewViewModal({ existingNames, onSave, onClose }: {
  existingNames: string[]
  onSave: (name: string, audience: ViewAudience, members: string[]) => void
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [audience, setAudience] = useState<ViewAudience>("me")
  const [members, setMembers] = useState<string[]>([])

  const trimmed = name.trim()
  const duplicate = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())
  const canSave = trimmed.length > 0 && !duplicate && (audience !== "specific" || members.length > 0)

  const toggleMember = (person: string) =>
    setMembers((prev) => (prev.includes(person) ? prev.filter((p) => p !== person) : [...prev, person]))

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-[17px] font-semibold text-gray-900">New View</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 transition-colors"><Ic.X /></button>
        </div>

        <div className="px-6 pb-4 overflow-y-auto">
          <label className="block text-[12px] font-medium text-gray-700 mb-1.5">
            <span className="text-red-500">*</span>Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) onSave(trimmed, audience, members) }}
            placeholder="e.g: Weekly view"
            className={`w-full text-[13px] border rounded-lg px-3 py-2 outline-none transition-colors
              ${duplicate ? "border-red-300 focus:border-red-400" : "border-gray-200 focus:border-indigo-300"}`}
          />
          {duplicate && <p className="text-[11px] text-red-500 mt-1">A view with this name already exists.</p>}

          <p className="text-[12px] font-medium text-gray-700 mt-5 mb-2">
            <span className="text-red-500">*</span>Make this view available for
          </p>
          <div className="flex flex-col gap-2.5">
            {(["me", "specific", "all"] as ViewAudience[]).map((opt) => (
              <label key={opt} className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="view-audience"
                  checked={audience === opt}
                  onChange={() => setAudience(opt)}
                  className="w-4 h-4 accent-indigo-600"
                />
                <span className="text-[13px] text-gray-800">{AUDIENCE_LABEL[opt]}</span>
              </label>
            ))}
          </div>

          {audience === "specific" && (
            <div className="mt-3 ml-6 border border-gray-200 rounded-lg max-h-[168px] overflow-y-auto">
              {PERSON_NAMES.map((person) => (
                <label key={person} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-indigo-50 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={members.includes(person)}
                    onChange={() => toggleMember(person)}
                    className="w-3.5 h-3.5 accent-indigo-600"
                  />
                  <span className="text-[13px] text-gray-700">{person}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="text-[13px] text-gray-700 bg-gray-100 rounded-lg px-4 py-2 hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => canSave && onSave(trimmed, audience, members)}
            disabled={!canSave}
            className={`text-[13px] rounded-lg px-5 py-2 font-medium transition-colors
              ${canSave ? "text-white bg-indigo-600 hover:bg-indigo-700" : "text-gray-400 bg-gray-100 cursor-not-allowed"}`}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function PageHeader({ reportMode, onReportModeChange, onSave, justSaved, dirty, saveBlockedReason, viewBlockedReason }: {
  reportMode: ReportMode
  onReportModeChange: (m: ReportMode) => void
  onSave: () => void
  justSaved: boolean
  /** Unsaved changes since the last save — drives the Save button's emphasis. */
  dirty: boolean
  /** Why Save is unavailable, or null when it is. An empty report has nothing to write. */
  saveBlockedReason: string | null
  /** Why View is unavailable, or null when it is. A report has to be saved, and non-empty,
      before it can be viewed — so the reason doubles as the disabled button's tooltip. */
  viewBlockedReason: string | null
}) {
  const [showExport, setShowExport] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportBtnRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center justify-between px-5 pt-3.5 pb-3 border-b border-gray-200 bg-white print-hide">
      <div>
        <p className="text-[10px] font-semibold text-indigo-500 mb-0.5 tracking-widest uppercase">Reports</p>
        <h1 className="text-[22px] font-semibold text-gray-900 leading-tight">Custom Reports V2.0</h1>
        {exportError && (
          <p className="text-[11px] text-amber-600 mt-0.5">
            {exportError}{" "}
            <button onClick={() => setExportError(null)} className="underline hover:text-amber-700">Dismiss</button>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {/* Export is a consumption action, not a build one — it appears once the builder has
            switched into view mode, where the report is finished and being read. */}
        {reportMode === "view" && (
        <div className="relative">
          <button
            ref={exportBtnRef}
            onClick={() => setShowExport((p) => !p)}
            title="Export this report"
            className={`flex items-center gap-1.5 text-[13px] border rounded-md px-3 py-1.5 transition-all
              ${showExport
                ? "text-indigo-600 border-indigo-300 bg-indigo-50"
                : "text-gray-600 border-gray-200 bg-white hover:bg-gray-50 hover:shadow-sm"}`}
          >
            <Ic.Download size={14} /><span>Export</span><Ic.ChevDown size={10} />
          </button>
          {showExport && (
            <ChipPortalMenu anchorRef={exportBtnRef} onClose={() => setShowExport(false)}>
              <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl py-1 w-56 overflow-hidden">
                <button
                  onClick={() => {
                    // Exports exactly what's rendered — current filters, formatting and layout all
                    // already applied, so there's nothing to keep in sync.
                    if (!exportReportXlsx()) setExportError("Nothing to export yet — build a report first.")
                    else setExportError(null)
                    setShowExport(false)
                  }}
                  className="flex items-start gap-2.5 w-full px-3 py-2 text-left hover:bg-indigo-50 transition-colors"
                >
                  <span className="text-gray-400 mt-0.5"><Ic.Sheet /></span>
                  <span>
                    <span className="block text-[13px] text-gray-800">Download Excel</span>
                    <span className="block text-[11px] text-gray-400 leading-snug">.xlsx with real numbers you can sum and chart.</span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    if (!exportReportCsv()) setExportError("Nothing to export yet — build a report first.")
                    else setExportError(null)
                    setShowExport(false)
                  }}
                  className="flex items-start gap-2.5 w-full px-3 py-2 text-left hover:bg-indigo-50 transition-colors"
                >
                  <span className="text-gray-400 mt-0.5"><Ic.Download size={13} /></span>
                  <span>
                    <span className="block text-[13px] text-gray-800">Download CSV</span>
                    <span className="block text-[11px] text-gray-400 leading-snug">The table exactly as shown, as plain text.</span>
                  </span>
                </button>
                <button
                  onClick={() => { setShowExport(false); setTimeout(() => window.print(), 0) }}
                  className="flex items-start gap-2.5 w-full px-3 py-2 text-left hover:bg-indigo-50 transition-colors"
                >
                  <span className="text-gray-400 mt-0.5"><Ic.Printer size={13} /></span>
                  <span>
                    <span className="block text-[13px] text-gray-800">Print / Save as PDF</span>
                    <span className="block text-[11px] text-gray-400 leading-snug">Opens your print dialog — choose "Save as PDF".</span>
                  </span>
                </button>
              </div>
            </ChipPortalMenu>
          )}
        </div>
        )}
        {reportMode === "create" && (
          <button
            onClick={onSave}
            disabled={saveBlockedReason !== null}
            title={saveBlockedReason ?? "Save this report's fields, filters, and formatting"}
            className={`flex items-center gap-1.5 text-[13px] rounded-md px-3 py-1.5 transition-all font-medium
              ${saveBlockedReason !== null
                ? "text-gray-400 border border-gray-200 bg-gray-100 cursor-not-allowed"
                : justSaved
                  ? "text-emerald-600 border border-emerald-200 bg-emerald-50 shadow-sm"
                  : dirty
                    ? "text-indigo-700 border border-indigo-300 bg-indigo-50 shadow-sm hover:bg-indigo-100 hover:shadow-sm"
                    : "text-gray-600 border border-gray-200 bg-white shadow-sm hover:bg-gray-50 hover:shadow-sm"}`}
          >
            {justSaved ? <Ic.Check /> : <Ic.Save size={14} />}
            <span>{justSaved ? "Saved" : "Save"}</span>
          </button>
        )}
        {reportMode === "create" ? (
          <button
            onClick={() => onReportModeChange("view")}
            disabled={viewBlockedReason !== null}
            title={viewBlockedReason ?? "Switch to view mode — hides the source picker, field browser, and drop areas"}
            className={`flex items-center gap-1.5 text-[13px] rounded-md px-3 py-1.5 transition-all font-medium
              ${viewBlockedReason !== null
                ? "text-gray-400 bg-gray-100 border border-gray-200 cursor-not-allowed"
                : "text-white bg-gray-900 shadow-sm hover:bg-gray-800 hover:shadow"}`}
          >
            <Ic.Eye size={14} /><span>View</span>
          </button>
        ) : (
          <button
            onClick={() => onReportModeChange("create")}
            title="Back to edit mode"
            className="flex items-center gap-1.5 text-[13px] text-white bg-gray-900 rounded-md px-3 py-1.5 shadow-sm hover:bg-gray-800 hover:shadow transition-all font-medium"
          >
            <Ic.Pencil size={14} /><span>Edit</span>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Toolbar ────────────────────────────────────────────────────────────────────

// The source chooser, shared by both builders. Forms leads on to its templates: a Forms report is
// always one template's, and picking one is picking the source (same confirm, same reset).
function SourcePicker({ source, setSource }: { source: string; setSource: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState(false)
  const toggle = () => { setOpen((p) => !p); setTemplates(isFormTemplateSource(source)) }
  const choose = (s: string) => { setSource(s); setOpen(false) }
  const item = (label: string, active: boolean, onClick: () => void, trailing?: React.ReactNode) => (
    <button
      key={label}
      onClick={onClick}
      className={`flex items-center justify-between w-full px-3 py-1.5 text-[13px] text-left hover:bg-indigo-50 transition-colors
        ${active ? "text-indigo-600 font-medium" : "text-gray-700"}`}
    >
      <span className="truncate">{label}</span>
      {trailing ?? (active && <Ic.Check />)}
    </button>
  )
  return (
    <div className="relative">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 text-gray-700 pr-3 border-r border-gray-200 hover:text-gray-900 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
        </svg>
        <span className="font-semibold">{sourceLabel(source)}</span>
        <Ic.ChevDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-56">
            {templates ? (
              <>
                <button
                  onClick={() => setTemplates(false)}
                  className="flex items-center gap-1 px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider hover:text-gray-600"
                >
                  <span className="rotate-180 inline-flex"><Ic.ChevRight size={10} /></span>
                  Forms · Template
                </button>
                {FORM_TEMPLATES.map((t) => item(t.name, source === t.name, () => choose(t.name)))}
              </>
            ) : (
              <>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pt-2 pb-1">Source</p>
                {SOURCE_OPTIONS.map((opt) => opt === "Forms"
                  ? item(opt, isFormTemplateSource(source), () => setTemplates(true), <span className="text-gray-400"><Ic.ChevRight size={11} /></span>)
                  : item(opt, source === opt, () => choose(opt)))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Toolbar({ source, setSource, fields, reportView, onReportViewChange, showTotals, onShowTotalsChange, fieldFormats, onFieldFormatChange, showModuleTag, onShowModuleTagChange, showProjectCurrency, onShowProjectCurrencyChange, reportMode, viewBar }: {
  source: string; setSource: (s: string) => void
  /** The saved-views controls, which take over this bar's left side in view mode. */
  viewBar: React.ReactNode
  fields: PivotFields
  reportView: ReportView
  onReportViewChange: (v: ReportView) => void
  showTotals: boolean
  onShowTotalsChange: (v: boolean) => void
  fieldFormats: Record<string, FieldFormat>
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
  showModuleTag: boolean
  onShowModuleTagChange: (v: boolean) => void
  showProjectCurrency: boolean
  onShowProjectCurrencyChange: (v: boolean) => void
  reportMode: ReportMode
}) {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <div className="flex items-center gap-3 px-5 py-2 border-b border-gray-200 bg-white text-[13px] print-hide">
      {reportMode === "view" && viewBar}
      {/* Source chooser + Lookups — build-time-only, hidden in view mode */}
      {reportMode === "create" && <SourcePicker source={source} setSource={setSource} />}

      <div className="flex items-center gap-1 ml-auto">
        {/* Compact / Detail view toggle — also in the settings panel; both stay in sync */}
        <div className="flex items-center rounded-md border border-gray-200 p-0.5">
          <button
            title="Detail view"
            onClick={() => onReportViewChange("detail")}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors
              ${reportView === "detail" ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
          >
            <Ic.ViewDetail size={13} />
          </button>
          <button
            title="Compact view"
            onClick={() => onReportViewChange("compact")}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors
              ${reportView === "compact" ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
          >
            <Ic.ViewCompact size={13} />
          </button>
        </div>

        {reportMode === "create" && <HighlightToolbarButton />}

        {/* Show/hide totals (grand total + subtotals) — also in the settings panel */}
        <button
          title={showTotals ? "Hide totals" : "Show totals"}
          onClick={() => onShowTotalsChange(!showTotals)}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors
            ${showTotals ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
        >
          <Ic.Sigma size={14} />
        </button>

        {/* Report settings panel — layout/totals duplicated here for discoverability, plus
            the Formatting subsection which has no toolbar equivalent */}
        <button
          title="Report settings"
          onClick={() => setShowSettings(true)}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors
            ${showSettings ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
        >
          <Ic.Gear size={15} />
        </button>
      </div>

      {showSettings && (
        <ReportSettingsPanel
          fields={fields}
          reportView={reportView}
          onReportViewChange={onReportViewChange}
          showTotals={showTotals}
          onShowTotalsChange={onShowTotalsChange}
          fieldFormats={fieldFormats}
          onFieldFormatChange={onFieldFormatChange}
          showModuleTag={showModuleTag}
          onShowModuleTagChange={onShowModuleTagChange}
          showProjectCurrency={showProjectCurrency}
          onShowProjectCurrencyChange={onShowProjectCurrencyChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

// Report-level settings — a right-side slide-in panel (not a centered modal), opened from the
// toolbar's gear icon. Houses settings that apply to the whole pivot report (layout, totals),
// as opposed to per-field settings which live on each field's own chip/dropdown.
function ReportSettingsPanel({ fields, reportView, onReportViewChange, showTotals, onShowTotalsChange, fieldFormats, onFieldFormatChange, showModuleTag, onShowModuleTagChange, showProjectCurrency, onShowProjectCurrencyChange, onClose }: {
  fields: PivotFields
  reportView: ReportView
  onReportViewChange: (v: ReportView) => void
  showTotals: boolean
  onShowTotalsChange: (v: boolean) => void
  fieldFormats: Record<string, FieldFormat>
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
  showModuleTag: boolean
  onShowModuleTagChange: (v: boolean) => void
  showProjectCurrency: boolean
  onShowProjectCurrencyChange: (v: boolean) => void
  onClose: () => void
}) {
  // Every field currently dropped into Columns/Rows/Values, in that order — the Formatting
  // subsection lists one editable block per instance (matches the per-instance identity the
  // rest of the app already uses: aggregations/rangeConfigs are keyed the same way).
  const formatItems: { item: PivotItem; zone: string }[] = [
    ...fields.columns.map((item) => ({ item, zone: "Columns" })),
    ...fields.rows.map((item) => ({ item, zone: "Rows" })),
    ...fields.values.map((item) => ({ item, zone: "Values" })),
  ]

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white w-96 h-full shadow-2xl flex flex-col animate-panel-in">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 shrink-0">
          <Ic.Gear size={16} />
          <span className="text-[15px] font-semibold text-gray-900">Report settings</span>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-lg hover:bg-gray-100">
            <Ic.X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
          {/* Layout */}
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Layout</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onReportViewChange("detail")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border text-[13px] font-medium transition-colors
                  ${reportView === "detail" ? "bg-indigo-50 border-indigo-300 text-indigo-600" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
              >
                <Ic.ViewDetail size={14} /> Detail
              </button>
              <button
                onClick={() => onReportViewChange("compact")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border text-[13px] font-medium transition-colors
                  ${reportView === "compact" ? "bg-indigo-50 border-indigo-300 text-indigo-600" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
              >
                <Ic.ViewCompact size={14} /> Compact
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
              {reportView === "detail"
                ? "One column per row field."
                : "Row fields collapse into a single indented, expandable column."}
            </p>
          </div>

          {/* Totals */}
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Totals</p>
            <label className="flex items-center justify-between cursor-pointer select-none py-1">
              <span className="text-[13px] text-gray-700">Show grand totals &amp; subtotals</span>
              <span
                onClick={() => onShowTotalsChange(!showTotals)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
                  ${showTotals ? "bg-indigo-600" : "bg-gray-200"}`}
              >
                <span className={`inline-block w-3.5 h-3.5 transform rounded-full bg-white transition-transform
                  ${showTotals ? "translate-x-[18px]" : "translate-x-1"}`} />
              </span>
            </label>
          </div>

          {/* Headers */}
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Headers</p>
            <label className="flex items-center justify-between cursor-pointer select-none py-1">
              <span className="text-[13px] text-gray-700">Show source module in headers</span>
              <span
                onClick={() => onShowModuleTagChange(!showModuleTag)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
                  ${showModuleTag ? "bg-indigo-600" : "bg-gray-200"}`}
              >
                <span className={`inline-block w-3.5 h-3.5 transform rounded-full bg-white transition-transform
                  ${showModuleTag ? "translate-x-[18px]" : "translate-x-1"}`} />
              </span>
            </label>
            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
              Tags each header with its owning module — helps tell apart same-named fields dropped from different modules.
            </p>
          </div>

          {/* Currency — money values default to the org's base currency (no code shown, same
              as today); this reads each row's own Project::Project currency instead. A total
              spanning more than one project's currency shows no code at all rather than picking
              one arbitrarily, since that would misrepresent a mixed-currency sum. */}
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Currency</p>
            <label className="flex items-center justify-between cursor-pointer select-none py-1">
              <span className="text-[13px] text-gray-700">View table values in project's currency</span>
              <span
                onClick={() => onShowProjectCurrencyChange(!showProjectCurrency)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
                  ${showProjectCurrency ? "bg-indigo-600" : "bg-gray-200"}`}
              >
                <span className={`inline-block w-3.5 h-3.5 transform rounded-full bg-white transition-transform
                  ${showProjectCurrency ? "translate-x-[18px]" : "translate-x-1"}`} />
              </span>
            </label>
            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
              Tags each money value with its own project's currency. A total spanning projects with different currencies shows no tag.
            </p>
          </div>

          {/* Formatting — one compact row per field rather than a full expanded card, so this
              stays usable with a dozen+ fields dropped in; each row opens the same controls
              (FieldFormatFields) in a popover, same as the chip-level gear icon. */}
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Formatting</p>
            {formatItems.length === 0 ? (
              <p className="text-[12px] text-gray-400 leading-relaxed">
                Drop a field into Columns, Rows, or Values to format it here.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {formatItems.map(({ item, zone }) => (
                  <FieldFormatListItem
                    key={item.id}
                    item={item}
                    zone={zone}
                    format={fieldFormats[item.id] ?? DEFAULT_FIELD_FORMAT}
                    onChange={(patch) => onFieldFormatChange(item.id, patch)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// One field's formatting block in the panel — rename always available; decimals/units only
// for numeric-ish fields (money/number/hours/percent). No currency-symbol control by design —
// this app's money formatting is always "$", so there's nothing to pick.
// The actual rename/alignment/decimals/units controls for one field — shared between the
// settings panel's per-field list (wrapped in FieldFormatRow, below) and the matching
// gear-icon popover on the field's own chip, so both surfaces stay pixel-identical and can
// never drift apart.
// Shared look for the small settings menus: one label style, one dropdown style.
const SETTINGS_LABEL = "text-[11px] text-gray-500 block mb-1"
function SettingsSelect({ value, onChange, children, ariaLabel }: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none w-full border border-gray-200 rounded-md pl-2 pr-7 py-1.5 text-[13px] text-gray-800 bg-white cursor-pointer focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"><Ic.ChevDown size={11} /></span>
    </div>
  )
}
const SETTINGS_SECTION = "text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2"

function FieldFormatFields({ item, defaultAlign, format, onChange }: {
  item: PivotItem
  defaultAlign: "left" | "right"
  format: FieldFormat
  onChange: (patch: Partial<FieldFormat>) => void
}) {
  const type = getFieldType(item.field)
  const numeric = isNumericType(type)
  const effectiveAlign = format.align === "auto" ? defaultAlign : format.align
  const alignBtn = (align: "left" | "center" | "right", icon: ReturnType<typeof Ic.AlignLeft>) => (
    <button
      key={align}
      title={align.charAt(0).toUpperCase() + align.slice(1)}
      onClick={() => onChange({ align })}
      className={`flex items-center justify-center w-7 h-6 rounded transition-colors
        ${effectiveAlign === align ? "bg-indigo-600 text-white shadow-sm" : "text-gray-500 hover:bg-gray-100"}`}
    >
      {icon}
    </button>
  )
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <label className={SETTINGS_LABEL}>Display name</label>
        <input
          type="text"
          value={format.displayName}
          placeholder={fieldDisplayName(item.field)}
          onChange={(e) => onChange({ displayName: e.target.value })}
          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-[13px] text-gray-800 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
        />
      </div>
      <div>
        <label className={SETTINGS_LABEL}>Alignment</label>
        <div className="flex items-center rounded-md border border-gray-200 p-0.5 bg-white w-fit">
          {alignBtn("left", <Ic.AlignLeft size={13} />)}
          {alignBtn("center", <Ic.AlignCenter size={13} />)}
          {alignBtn("right", <Ic.AlignRight size={13} />)}
        </div>
      </div>
      {numeric && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={SETTINGS_LABEL}>Decimals</label>
            <SettingsSelect
              value={format.decimals === null ? "auto" : String(format.decimals)}
              onChange={(v) => onChange({ decimals: v === "auto" ? null : Number(v) })}
            >
              <option value="auto">Auto</option>
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </SettingsSelect>
          </div>
          <div>
            <label className={SETTINGS_LABEL}>Units</label>
            <SettingsSelect value={format.units} onChange={(v) => onChange({ units: v as FieldFormat["units"] })}>
              <option value="none">None</option>
              <option value="K">Thousands (K)</option>
              <option value="L">Lakhs (L)</option>
              <option value="M">Millions (M)</option>
              <option value="C">Crores (C)</option>
              <option value="B">Billions (B)</option>
              <option value="auto">Auto (K, M, B)</option>
              <option value="autoIN">Auto (K, L, C)</option>
              <option value="autoLocale">Auto (viewer's locale)</option>
            </SettingsSelect>
          </div>
        </div>
      )}
    </div>
  )
}

// One line per field in the settings panel's Formatting list — click opens a popover with the
// full FieldFormatFields controls, so the list itself stays scannable no matter how many fields
// are dropped. The dot marks a field whose format has actually been touched, since a collapsed
// row otherwise gives no hint that a customization exists underneath.
function FieldFormatListItem({ item, zone, format, onChange }: {
  item: PivotItem
  zone: string
  format: FieldFormat
  onChange: (patch: Partial<FieldFormat>) => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const type = getFieldType(item.field)
  const isCustomized = format.displayName !== "" || format.align !== "auto" || format.decimals !== null || format.units !== "auto"
  const label = format.displayName.trim() !== "" ? format.displayName : fieldDisplayName(item.field)

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setShowMenu((p) => !p)}
        className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md border text-left transition-colors
          ${showMenu ? "border-indigo-300 bg-indigo-50/60" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"}`}
      >
        {fieldTypeIcon(type, 12)}
        <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider shrink-0">{zone}</span>
        <span className="text-[13px] text-gray-800 truncate flex-1">{label}</span>
        {isCustomized && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
        <span className="text-gray-400 shrink-0"><Ic.ChevDown size={9} /></span>
      </button>

      {showMenu && (
        <ChipPortalMenu anchorRef={btnRef} onClose={() => setShowMenu(false)}>
          <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-2.5 w-72">
            <FieldFormatFields item={item} defaultAlign={zone === "Values" ? "right" : "left"} format={format} onChange={onChange} />
          </div>
        </ChipPortalMenu>
      )}
    </div>
  )
}

// ── Field browser (left panel) ─────────────────────────────────────────────────

// ── Formula fields & conditional highlighting: shared host ───────────────────────
// Both features are today's, brought over unchanged — same wording, same rules, same saved shape.
// The builders render a ReportExtrasHost, which owns the two drawers and the toasts; shelves,
// chips, the field list, the toolbar and the table reach it through this context.

type HighlightCondition = "GREATER_THAN" | "LESSER_THAN" | "EQUALS"
interface HighlightRule {
  ruleId: string
  /** The field the rule colours — every chip of that field shares its rules, as today. */
  fieldName: string
  fieldLabel: string
  highlightingType: "SINGLE_COLOR" | "MULTI_COLOR"
  conditionType?: HighlightCondition
  threshold?: string
  color?: string
  multiColorType?: "CUSTOM" | "SMART"
  min?: number
  max?: number
  paletteType?: string
}

const HL_COLORS: Record<string, { bg: string; white?: boolean }> = {
  Green20: { bg: "#D1FAE5" }, Green30: { bg: "#A7F3D0" }, Green40: { bg: "#34D399", white: true }, Green50: { bg: "#059669", white: true },
  Yellow20: { bg: "#FEF3C7" }, Yellow30: { bg: "#FDE68A" }, Yellow40: { bg: "#F59E0B", white: true }, Yellow50: { bg: "#D97706", white: true },
  Red20: { bg: "#FEE2E2" }, Red30: { bg: "#FCA5A5" }, Red40: { bg: "#EF4444", white: true }, Red50: { bg: "#B91C1C", white: true },
}
const HL_SINGLE_SWATCHES = ["Green40", "Green20", "Yellow30", "Yellow50", "Red20", "Red40"]
const HL_PALETTES: { id: string; group: "Multi color" | "Single color"; colors: string[] }[] = [
  { id: "MULTI", group: "Multi color", colors: ["Green40", "Green20", "Yellow30", "Yellow40", "Red20", "Red40"] },
  { id: "GREEN", group: "Single color", colors: ["Green20", "Green30", "Green40", "Green50"] },
  { id: "YELLOW", group: "Single color", colors: ["Yellow20", "Yellow30", "Yellow40", "Yellow50"] },
  { id: "RED", group: "Single color", colors: ["Red20", "Red30", "Red40", "Red50"] },
]
const HL_CONDITION_LABEL: Record<HighlightCondition, string> = {
  GREATER_THAN: "Greater than", LESSER_THAN: "Lesser than", EQUALS: "Equals to",
}

function hlRuleText(r: HighlightRule): string {
  if (r.highlightingType === "MULTI_COLOR") return r.multiColorType === "SMART" ? "Smart highlight" : `Min ${r.min} - Max ${r.max}`
  if (r.conditionType === "GREATER_THAN") return `is greater than ${r.threshold}`
  if (r.conditionType === "LESSER_THAN") return `less than ${r.threshold}`
  return `equals ${r.threshold}`
}

/** The colour a cell gets: the first of its field's rules that matches, in the drawer's order.
    The value is rounded the way it is shown before it is compared. */
function hlColorFor(rules: HighlightRule[], fieldKey: string, n: number): { bg: string; white?: boolean } | null {
  if (!Number.isFinite(n)) return null
  const v = Math.round(n * 100) / 100
  for (const r of rules) {
    if (r.fieldName !== fieldKey) continue
    if (r.highlightingType === "SINGLE_COLOR") {
      const t = Number(r.threshold)
      if (Number.isNaN(t)) continue
      const hit = r.conditionType === "GREATER_THAN" ? v > t : r.conditionType === "LESSER_THAN" ? v < t : v === t
      if (hit && r.color && HL_COLORS[r.color]) return HL_COLORS[r.color]
    } else {
      const pal = HL_PALETTES.find((p) => p.id === r.paletteType)
      if (!pal || r.min == null || r.max == null || r.max <= r.min) continue
      if (v < r.min || v > r.max) continue
      const k = pal.colors.length
      const band = Math.min(k - 1, Math.floor(((v - r.min) / (r.max - r.min)) * k))
      return HL_COLORS[pal.colors[band]]
    }
  }
  return null
}

interface ReportExtrasCtx {
  highlightRules: HighlightRule[]
  /** Opens the highlighting drawer — on a field's rules when one is given. */
  openHighlight: (fieldKey?: string) => void
  /** Opens the formula editor: a new formula, or an existing one to edit. */
  openFormula: (editing?: FormulaDef) => void
  deleteFormula: (def: FormulaDef) => void
  /** The shelf that carries the "+ Formula" button: Values in a pivot, Columns in a table. */
  formulaZone: ZoneKey | null
  /** Which fields can be highlighted (the report's number values / number columns). */
  canHighlight: boolean
}
const ReportExtras = createContext<ReportExtrasCtx>({
  highlightRules: [], openHighlight: () => {}, openFormula: () => {}, deleteFormula: () => {}, formulaZone: null, canHighlight: false,
})

/** The cell style a highlight rule gives a value, or nothing. */
function useHighlightStyle() {
  const { highlightRules } = useContext(ReportExtras)
  return (fieldKey: string, n: number): React.CSSProperties | undefined => {
    const c = hlColorFor(highlightRules, fieldKey, n)
    return c ? { backgroundColor: c.bg, color: c.white ? "#fff" : undefined } : undefined
  }
}

function BrushIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z" />
      <path d="M9.2 12c-2.2 0-3.7 1.6-3.9 3.6-.2 1.6-1 2.7-2.3 3.4 1.2.9 3 1.4 4.8 1.4 3.1 0 5.4-2.3 5.4-5.2z" />
    </svg>
  )
}
function FxIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 20c1.5 0 2.2-1 2.6-3l1.8-10c.4-2 1.1-3 2.6-3" /><path d="M8 10h7" /><path d="M15 13l5 6" /><path d="M20 13l-5 6" />
    </svg>
  )
}

/** Shows `text` at the pointer while hovering — the instant tooltip a disabled control carries. */
function HoverTip({ text, children, className }: { text: string | null; children: React.ReactNode; className?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <span
      className={className ?? "inline-flex"}
      onMouseMove={(e) => text && setAt({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setAt(null)}
    >
      {children}
      {text && at && <CursorTooltip text={text} at={at} />}
    </span>
  )
}

// ── Toasts ──
interface ToastMsg { id: number; kind: "success" | "error"; title: string; message: string }
function ToastStack({ toasts, onDismiss }: { toasts: ToastMsg[]; onDismiss: (id: number) => void }) {
  return createPortal(
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[400] flex flex-col gap-2 items-center">
      {toasts.map((t) => (
        <div key={t.id} role="status" className="flex items-start gap-2.5 bg-white border border-gray-200 rounded-lg shadow-xl px-3.5 py-2.5 w-[360px] animate-chip-in">
          <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-white ${t.kind === "success" ? "bg-emerald-500" : "bg-red-500"}`}>
            {t.kind === "success" ? <Ic.Check /> : <span className="text-[10px] font-bold">!</span>}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-gray-900">{t.title}</p>
            <p className="text-[12px] text-gray-500 mt-0.5">{t.message}</p>
          </div>
          <button onClick={() => onDismiss(t.id)} className="text-gray-300 hover:text-gray-600"><Ic.X size={11} /></button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

// ── Formula editor (today's drawer) ──
const LETTER_COLORS = ["#6366F1", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"]

/** The number and date fields a formula on this source can use. Today a formula can reach the
    source's own fields and the tables beneath it (totalled per record); tables above it are
    listed but greyed out. */
function formulaFieldGroups(source: string): { module: string; compatible: boolean; fields: Field[] }[] {
  const srcRank = MODULE_RANK[source] ?? 0
  return (SOURCE_MODULES[source] ?? [source])
    .map((name) => MODULES.find((m) => m.name === name))
    .filter((m): m is Module => !!m)
    .map((m) => ({
      module: m.name,
      compatible: m.name === source || (MODULE_RANK[m.name] ?? 0) > srcRank,
      fields: m.fields.filter((f) => isNumericType(f.type) || f.type === "date"),
    }))
    .filter((g) => g.fields.length > 0)
}

function FormulaFieldDrawer({ source, editing, onClose, onSaved, toast }: {
  source: string
  editing: FormulaDef | null
  onClose: () => void
  onSaved: (def: FormulaDef, created: boolean) => void
  toast: (t: Omit<ToastMsg, "id">) => void
}) {
  const [name, setName] = useState(editing?.name ?? "")
  const [expression, setExpression] = useState(editing?.expression ?? "")
  const [refs, setRefs] = useState<FormulaRef[]>(editing?.refs ?? [])
  const [excludeWeekends, setExcludeWeekends] = useState(editing?.excludeWeekends ?? false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState("")
  const [incompatTip, setIncompatTip] = useState<{ x: number; y: number } | null>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const groups = formulaFieldGroups(source)
  const hasDate = refs.some((r) => getFieldType(r.field) === "date")

  const addRef = (field: string) => {
    setRefs((prev) => {
      if (prev.length + 1 > 26) return prev
      const used = new Set(prev.map((r) => r.letter))
      const letter = FORMULA_LETTERS.find((l) => !used.has(l))!
      return [...prev, { letter, field }]
    })
  }

  const missing = !name.trim() && !expression.trim() ? "Field name and formula are required"
    : !name.trim() ? "Field name is required"
    : !expression.trim() ? "Formula is required" : null

  const submit = () => {
    if (missing) return
    const expr = expression.trim().toUpperCase()
    if (!formulaIsValid(expr, refs)) {
      toast({
        kind: "error", title: "Something went wrong!",
        message: editing ? "An error occurred while updating the formula field. Please try again." : "An error occurred while creating the formula field. Please try again.",
      })
      return
    }
    const def: FormulaDef = {
      id: editing?.id ?? `f${Date.now().toString(36)}`,
      name: name.trim(), source, refs, expression: expr, excludeWeekends: hasDate && excludeWeekends,
    }
    setFormulas(editing ? FORMULAS.map((f) => (f.id === def.id ? def : f)) : [...FORMULAS, def])
    toast({
      kind: "success",
      title: editing ? "Formula field updated!" : "Formula field created!",
      message: `'${def.name}' field has been ${editing ? "updated" : "created"} successfully.`,
    })
    onSaved(def, !editing)
  }

  const labelCls = "text-[12px] font-medium text-gray-700 block mb-1.5"
  const q = pickerSearch.trim().toLowerCase()

  return createPortal(
    <div className="fixed inset-0 z-[200] flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white h-full w-[1110px] max-w-[96vw] shadow-2xl flex flex-col">
        <div className="flex items-center px-6 py-4 border-b border-gray-200">
          <span className="text-[16px] font-semibold text-gray-900 flex-1">{editing ? "Edit formula field" : "New formula field"}</span>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"><Ic.X size={14} /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: the fields the formula uses */}
          <div className="w-[400px] shrink-0 border-r border-gray-200 p-6 flex flex-col gap-5 overflow-y-auto bg-gray-50/50">
            <div>
              <label className={labelCls}>Show fields related to</label>
              <SettingsSelect value={source} onChange={() => {}} ariaLabel="Show fields related to">
                <option value={source}>{source}</option>
              </SettingsSelect>
              <p className="text-[11px] text-gray-400 mt-1.5">Formula created will also be a {source} field</p>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center">
                <span className="text-[12px] font-medium text-gray-700 flex-1">Fields used in formula</span>
                <button
                  ref={addBtnRef}
                  onClick={() => setPickerOpen((p) => !p)}
                  className="flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-800"
                >
                  <span className="text-[14px] leading-none">+</span> Add field
                </button>
              </div>
              {pickerOpen && (
                <ChipPortalMenu anchorRef={addBtnRef} onClose={() => { setPickerOpen(false); setPickerSearch("") }}>
                  <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl w-72 overflow-hidden">
                    <div className="px-2.5 py-2 border-b border-gray-100">
                      <input
                        autoFocus value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="Search…"
                        className="w-full bg-gray-50 rounded-md px-2.5 py-1.5 text-[13px] focus:outline-none"
                      />
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                      {groups.map((g) => {
                        const list = g.fields.filter((f) => !q || f.name.toLowerCase().includes(q) || g.module.toLowerCase().includes(q))
                        if (list.length === 0) return null
                        return (
                          <div key={g.module}>
                            <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{g.module}</p>
                            {list.map((f) => {
                              const key = makeFieldKey(g.module, f.name)
                              const used = refs.some((r) => r.field === key)
                              return g.compatible ? (
                                <button
                                  key={key}
                                  onClick={() => !used && addRef(key)}
                                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-left ${used ? "text-gray-400" : "text-gray-700 hover:bg-indigo-50"}`}
                                >
                                  {fieldTypeIcon(f.type)}<span className="flex-1 truncate">{f.name}</span>{used && <Ic.Check />}
                                </button>
                              ) : (
                                <div
                                  key={key}
                                  onMouseMove={(e) => setIncompatTip({ x: e.clientX, y: e.clientY })}
                                  onMouseLeave={() => setIncompatTip(null)}
                                  className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-gray-300 cursor-not-allowed"
                                >
                                  {fieldTypeIcon(f.type)}<span className="flex-1 truncate">{f.name}</span>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  {incompatTip && <CursorTooltip text="Field is not compatible with the source" at={incompatTip} />}
                </ChipPortalMenu>
              )}

              {refs.map((r, i) => {
                const type = getFieldType(r.field)
                return (
                  <div key={r.letter} className="group flex items-center gap-2.5 bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <span className="w-6 h-6 rounded-full text-white text-[12px] font-bold flex items-center justify-center shrink-0"
                      style={{ backgroundColor: LETTER_COLORS[i % LETTER_COLORS.length] }}>{r.letter}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-gray-800 truncate">{fieldDisplayName(r.field)}</p>
                      <p className="text-[11px] text-gray-400 truncate">{fieldKeyModule(r.field)}</p>
                    </div>
                    <select disabled className="border border-gray-200 rounded-md px-1.5 py-1 text-[12px] text-gray-400 bg-gray-50 w-20">
                      <option>{type === "date" ? "None" : "Sum"}</option>
                    </select>
                    <button
                      onClick={() => setRefs((prev) => prev.filter((x) => x.letter !== r.letter))}
                      aria-label="Remove field"
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-600 transition-opacity"
                    ><Ic.X size={11} /></button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: name and expression */}
          <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
            <p className="text-[15px] font-semibold text-gray-900">{editing ? "Edit your formula" : "Build your formula"}</p>
            <div>
              <label className={labelCls}>Field name <span className="text-red-500">*</span></label>
              <input
                value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled formula"
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className={labelCls}>Formula <span className="text-red-500">*</span></label>
              <textarea
                rows={5} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="Eg: (A/B)*100"
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-[13px] resize-y focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
              />
            </div>
            {hasDate && (
              <div>
                <p className="text-[12px] font-medium text-gray-700 mb-1.5">Advanced</p>
                <label className="flex items-center gap-2 text-[13px] text-gray-700 cursor-pointer select-none">
                  <input type="checkbox" checked={excludeWeekends} onChange={(e) => setExcludeWeekends(e.target.checked)} className="w-3.5 h-3.5 accent-indigo-600" />
                  Skip weekends when calculating duration between dates
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3.5 border-t border-gray-200">
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-[13px] text-gray-600 hover:bg-gray-100">Cancel</button>
          <HoverTip text={missing}>
            <button
              onClick={submit}
              disabled={!!missing}
              className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
            >{editing ? "Update" : "Create"}</button>
          </HoverTip>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Conditional highlighting (today's drawer) ──
function PaletteStrip({ colors }: { colors: string[] }) {
  return (
    <span className="inline-flex rounded overflow-hidden border border-gray-200 shrink-0">
      {colors.map((c) => <span key={c} className="w-4 h-3.5" style={{ backgroundColor: HL_COLORS[c].bg }} />)}
    </span>
  )
}

function HighlightDrawer({ targets, rules, onRulesChange, initialField, onClose }: {
  /** The number fields this report can highlight, by field key. */
  targets: { field: string; label: string }[]
  rules: HighlightRule[]
  onRulesChange: (rules: HighlightRule[]) => void
  initialField?: string
  onClose: () => void
}) {
  type Draft = Omit<HighlightRule, "ruleId"> & { ruleId?: string }
  const blank = (field?: string): Draft => {
    const f = field ?? targets[0]?.field ?? ""
    return {
      fieldName: f, fieldLabel: targets.find((t) => t.field === f)?.label ?? "",
      highlightingType: "SINGLE_COLOR", conditionType: "GREATER_THAN", threshold: "", color: undefined,
      multiColorType: "CUSTOM", min: undefined, max: undefined, paletteType: undefined,
    }
  }
  const [draft, setDraft] = useState<Draft | null>(() =>
    initialField && !rules.some((r) => r.fieldName === initialField) ? blank(initialField) : null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteBtnRef = useRef<HTMLButtonElement>(null)

  const groups = [...new Set(rules.map((r) => r.fieldName))]
  const title = draft ? (draft.ruleId ? "Edit rule" : "Add a rule") : rules.length > 0 ? "Highlight rules" : "Conditional highlighting"

  const multiError = draft?.highlightingType === "MULTI_COLOR" && draft.min != null && draft.max != null && !(draft.max > draft.min)
    ? "Max value must be greater than min value" : null
  const draftValid = !!draft && !!draft.fieldName && (draft.highlightingType === "SINGLE_COLOR"
    ? draft.threshold !== "" && !Number.isNaN(Number(draft.threshold)) && !!draft.color
    : draft.min != null && draft.max != null && !multiError && !!draft.paletteType)

  const save = () => {
    if (!draft || !draftValid) return
    const rule: HighlightRule = { ...draft, ruleId: draft.ruleId ?? `r${Date.now().toString(36)}` }
    onRulesChange(draft.ruleId ? rules.map((r) => (r.ruleId === rule.ruleId ? rule : r)) : [...rules, rule])
    setDraft(null)
  }
  const reorder = (overId: string) => {
    if (!dragId || dragId === overId) return
    const from = rules.findIndex((r) => r.ruleId === dragId), to = rules.findIndex((r) => r.ruleId === overId)
    if (from < 0 || to < 0 || rules[from].fieldName !== rules[to].fieldName) return
    const next = [...rules]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onRulesChange(next)
  }

  const labelCls = "text-[12px] font-medium text-gray-700 block mb-1.5"
  const inputCls = "w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
  const fieldLabelOf = (key: string) => targets.find((t) => t.field === key)?.label ?? rules.find((r) => r.fieldName === key)?.fieldLabel ?? fieldDisplayName(key)
  const btn = "px-4 py-1.5 rounded-md text-[13px]"

  return createPortal(
    <div className="fixed inset-0 z-[200] flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative bg-white h-full w-[360px] shadow-2xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3.5 border-b border-gray-200">
          <span className="text-gray-500"><BrushIcon /></span>
          <span className="text-[14px] font-semibold text-gray-900 flex-1">{title}</span>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"><Ic.X size={12} /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {draft ? (
            <div className="p-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Select a field to conditionally highlight</label>
                <SettingsSelect value={draft.fieldName} onChange={(v) => setDraft({ ...draft, fieldName: v, fieldLabel: fieldLabelOf(v) })} ariaLabel="Field">
                  {targets.map((t) => <option key={t.field} value={t.field}>{t.label}</option>)}
                </SettingsSelect>
              </div>
              <div className="flex rounded-md border border-gray-200 p-0.5 bg-gray-50">
                {(["SINGLE_COLOR", "MULTI_COLOR"] as const).map((t) => (
                  <button key={t} onClick={() => setDraft({ ...draft, highlightingType: t })}
                    className={`flex-1 py-1.5 rounded text-[13px] font-medium transition-colors
                      ${draft.highlightingType === t ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                    {t === "SINGLE_COLOR" ? "Single color" : "Multi color"}
                  </button>
                ))}
              </div>

              {draft.highlightingType === "SINGLE_COLOR" ? (
                <>
                  <div>
                    <label className={labelCls}>Highlight when {fieldLabelOf(draft.fieldName)} is</label>
                    <div className="flex gap-2">
                      <div className="w-36 shrink-0">
                        <SettingsSelect value={draft.conditionType ?? "GREATER_THAN"} onChange={(v) => setDraft({ ...draft, conditionType: v as HighlightCondition })} ariaLabel="Condition">
                          {(Object.keys(HL_CONDITION_LABEL) as HighlightCondition[]).map((c) => <option key={c} value={c}>{HL_CONDITION_LABEL[c]}</option>)}
                        </SettingsSelect>
                      </div>
                      <input type="number" value={draft.threshold ?? ""} placeholder="Enter number" onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Highlight color</label>
                    <div className="flex gap-2">
                      {HL_SINGLE_SWATCHES.map((c) => (
                        <button key={c} onClick={() => setDraft({ ...draft, color: c })} aria-label={c}
                          className={`w-8 h-8 rounded-md border transition-shadow ${draft.color === c ? "ring-2 ring-indigo-500 ring-offset-1 border-transparent" : "border-gray-200 hover:shadow"}`}
                          style={{ backgroundColor: HL_COLORS[c].bg }} />
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={labelCls}>How should the cells be highlighted?</label>
                    <div className="flex items-start gap-2.5 border border-indigo-300 bg-indigo-50/50 rounded-md px-3 py-2.5">
                      <span className="mt-0.5 w-3.5 h-3.5 rounded-full border-2 border-indigo-600 flex items-center justify-center shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-indigo-600" /></span>
                      <span>
                        <span className="block text-[13px] font-medium text-gray-800">Custom</span>
                        <span className="block text-[12px] text-gray-500">Specify the min and max values manually</span>
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Min</label>
                      <input type="number" value={draft.min ?? ""} onChange={(e) => setDraft({ ...draft, min: e.target.value === "" ? undefined : Number(e.target.value) })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Max</label>
                      <input type="number" value={draft.max ?? ""} onChange={(e) => setDraft({ ...draft, max: e.target.value === "" ? undefined : Number(e.target.value) })} className={inputCls} />
                    </div>
                  </div>
                  {multiError && <p className="text-[12px] text-red-500 -mt-2">{multiError}</p>}
                  <div>
                    <label className={labelCls}>Pick a palette</label>
                    <button ref={paletteBtnRef} onClick={() => setPaletteOpen((p) => !p)}
                      className="w-full flex items-center gap-2 border border-gray-200 rounded-md px-2.5 py-1.5 bg-white text-[13px] text-gray-500">
                      <span className="flex-1 text-left">{draft.paletteType ? <PaletteStrip colors={HL_PALETTES.find((p) => p.id === draft.paletteType)!.colors} /> : "Select"}</span>
                      <Ic.ChevDown size={11} />
                    </button>
                    {paletteOpen && (
                      <ChipPortalMenu anchorRef={paletteBtnRef} onClose={() => setPaletteOpen(false)}>
                        <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl w-[326px] py-1">
                          {(["Multi color", "Single color"] as const).map((g) => (
                            <div key={g}>
                              <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{g}</p>
                              {HL_PALETTES.filter((p) => p.group === g).map((p) => (
                                <button key={p.id} onClick={() => { setDraft({ ...draft, paletteType: p.id }); setPaletteOpen(false) }}
                                  className={`flex items-center gap-2 w-full px-3 py-1.5 hover:bg-indigo-50 ${draft.paletteType === p.id ? "bg-indigo-50" : ""}`}>
                                  <PaletteStrip colors={p.colors} />
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      </ChipPortalMenu>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center text-center px-8 pt-16 gap-3">
              <span className="w-12 h-12 rounded-full bg-indigo-50 text-indigo-500 flex items-center justify-center"><BrushIcon size={20} /></span>
              <p className="text-[14px] font-semibold text-gray-800">You don't have any conditional highlighting set</p>
              <p className="text-[12px] text-gray-500 leading-relaxed">Use conditional highlighting to easily identify projects that are below target margins or resources that exceed 90% allocations</p>
              <button onClick={() => setDraft(blank(initialField))} className={`${btn} mt-1 font-medium bg-indigo-600 text-white hover:bg-indigo-700`}>Add a rule</button>
            </div>
          ) : (
            <div className="py-2">
              {groups.map((g) => (
                <div key={g}>
                  <button onClick={() => setCollapsed((p) => ({ ...p, [g]: !p[g] }))} className="flex items-center gap-1.5 w-full px-4 py-2 hover:bg-gray-50">
                    <span className="text-gray-400 inline-block" style={{ transform: collapsed[g] ? "rotate(-90deg)" : undefined }}><Ic.ChevDown size={11} /></span>
                    <span className="text-[13px] font-semibold text-gray-700 flex-1 text-left truncate">{fieldLabelOf(g)}</span>
                  </button>
                  {!collapsed[g] && rules.filter((r) => r.fieldName === g).map((r) => (
                    <div
                      key={r.ruleId}
                      draggable
                      onDragStart={() => setDragId(r.ruleId)}
                      onDragOver={(e) => { e.preventDefault(); reorder(r.ruleId) }}
                      onDragEnd={() => setDragId(null)}
                      className={`group flex items-center gap-2 mx-3 mb-1 pl-2 pr-1.5 py-1.5 rounded-md border bg-white cursor-grab
                        ${dragId === r.ruleId ? "border-indigo-300 opacity-60" : "border-gray-200"}`}
                    >
                      <span className="text-gray-300"><Ic.GripVertical /></span>
                      {r.highlightingType === "SINGLE_COLOR"
                        ? <span className="w-4 h-4 rounded shrink-0 border border-gray-200" style={{ backgroundColor: HL_COLORS[r.color ?? ""]?.bg }} />
                        : <PaletteStrip colors={(HL_PALETTES.find((p) => p.id === r.paletteType)?.colors ?? []).slice(0, 4)} />}
                      <span className="text-[12px] text-gray-700 flex-1 truncate">{hlRuleText(r)}</span>
                      <button onClick={() => setDraft({ ...r })} aria-label="Edit rule" className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-700"><Ic.Pencil size={12} /></button>
                      <button onClick={() => onRulesChange(rules.filter((x) => x.ruleId !== r.ruleId))} aria-label="Delete rule" className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500"><Ic.Trash size={12} /></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {(draft || rules.length > 0) && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200">
            {draft ? (
              <>
                <button onClick={() => setDraft(null)} className={`${btn} text-gray-600 hover:bg-gray-100`}>Back</button>
                <button onClick={save} disabled={!draftValid}
                  className={`${btn} font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed`}>
                  {draft.ruleId ? "Edit rule" : "Create"}
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose} className={`${btn} text-gray-600 hover:bg-gray-100`}>Cancel</button>
                <button onClick={() => setDraft(blank())} className={`${btn} font-medium bg-indigo-600 text-white hover:bg-indigo-700`}>Add a rule</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Owns the formula editor, the highlighting drawer and toasts for one builder. */
function ReportExtrasHost({ source, formulaZone, targets, highlightRules, onHighlightRulesChange, onFormulaCreated, onFormulaDeleted, children }: {
  source: string
  formulaZone: ZoneKey
  targets: { field: string; label: string }[]
  highlightRules: HighlightRule[]
  onHighlightRulesChange: (rules: HighlightRule[]) => void
  onFormulaCreated: (key: string) => void
  onFormulaDeleted: (key: string) => void
  children: React.ReactNode
}) {
  const [formulaDrawer, setFormulaDrawer] = useState<{ editing: FormulaDef | null } | null>(null)
  const [highlight, setHighlight] = useState<{ field?: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FormulaDef | null>(null)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const toast = (t: Omit<ToastMsg, "id">) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { ...t, id }])
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4000)
  }
  const ctx: ReportExtrasCtx = {
    highlightRules,
    openHighlight: (field) => setHighlight({ field }),
    openFormula: (editing) => setFormulaDrawer({ editing: editing ?? null }),
    deleteFormula: (def) => setPendingDelete(def),
    formulaZone,
    canHighlight: targets.length > 0,
  }
  return (
    <ReportExtras.Provider value={ctx}>
      {children}
      {formulaDrawer && (
        <FormulaFieldDrawer
          source={source}
          editing={formulaDrawer.editing}
          onClose={() => setFormulaDrawer(null)}
          toast={toast}
          onSaved={(def, created) => { setFormulaDrawer(null); if (created) onFormulaCreated(formulaKeyOf(def)) }}
        />
      )}
      {highlight && (
        <HighlightDrawer
          targets={targets}
          rules={highlightRules}
          onRulesChange={onHighlightRulesChange}
          initialField={highlight.field}
          onClose={() => setHighlight(null)}
        />
      )}
      {pendingDelete && createPortal(
        <div className="fixed inset-0 z-[250] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setPendingDelete(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[420px] p-5">
            <p className="text-[15px] font-semibold text-gray-900">Delete Field</p>
            <p className="text-[13px] text-gray-600 mt-2 leading-relaxed">All the details belongs to this field will be deleted and cannot be recovered. Are you sure you want to delete this field?</p>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setPendingDelete(null)} className="px-4 py-1.5 rounded-md text-[13px] text-gray-600 hover:bg-gray-100">Cancel</button>
              <button
                onClick={() => {
                  const key = formulaKeyOf(pendingDelete)
                  setFormulas(FORMULAS.filter((f) => f.id !== pendingDelete.id))
                  onFormulaDeleted(key)
                  setPendingDelete(null)
                }}
                className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-red-600 text-white hover:bg-red-700"
              >Delete</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))} />
    </ReportExtras.Provider>
  )
}

/** The toolbar's "Conditional highlighting" button — build mode only, as today. */
function HighlightToolbarButton() {
  const { canHighlight, highlightRules, openHighlight } = useContext(ReportExtras)
  return (
    <HoverTip text={canHighlight ? null : "Atleast one number field is required."}>
      <button
        title={canHighlight ? "Conditional highlighting" : undefined}
        aria-label="Conditional highlighting"
        disabled={!canHighlight}
        onClick={() => openHighlight()}
        className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors
          ${!canHighlight ? "text-gray-300 cursor-not-allowed" : highlightRules.length > 0 ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
      >
        <BrushIcon />
      </button>
    </HoverTip>
  )
}

/** The brush beside a highlighted column's header; hovering lists that field's rules. */
function HighlightHeaderMark({ field }: { field: string }) {
  const { highlightRules } = useContext(ReportExtras)
  const mine = highlightRules.filter((r) => r.fieldName === field)
  const [at, setAt] = useState<DOMRect | null>(null)
  if (mine.length === 0) return null
  return (
    <span
      className="inline-flex align-middle ml-1 text-indigo-400"
      onMouseEnter={(e) => setAt((e.currentTarget as HTMLElement).getBoundingClientRect())}
      onMouseLeave={() => setAt(null)}
    >
      <BrushIcon size={11} />
      {at && createPortal(
        <div style={{ position: "fixed", left: Math.min(at.left, window.innerWidth - 240), top: at.bottom + 6 }}
          className="z-[300] bg-gray-900 text-white rounded-md shadow-lg px-2.5 py-2 w-56 pointer-events-none">
          <p className="text-[11px] font-semibold mb-1">Highlight rules</p>
          {mine.map((r) => (
            <p key={r.ruleId} className="flex items-center gap-1.5 text-[11px] font-normal py-0.5">
              {r.highlightingType === "SINGLE_COLOR"
                ? <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: HL_COLORS[r.color ?? ""]?.bg }} />
                : <PaletteStrip colors={(HL_PALETTES.find((p) => p.id === r.paletteType)?.colors ?? []).slice(0, 4)} />}
              {hlRuleText(r)}
            </p>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}

// The Build panel — Columns, Rows, Values, Filters and View filters stacked in one column between
// the field list and the report, so the report gets the full height. Collapsible, like the design.
function BuildPanel({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  if (collapsed) {
    return (
      <aside className="w-10 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-3 print-hide">
        <button onClick={() => setCollapsed(false)} title="Show build panel" className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
          <span className="inline-block rotate-180"><Ic.ChevRight size={11} /></span><span className="inline-block rotate-180 -ml-1"><Ic.ChevRight size={11} /></span>
        </button>
        <span className="mt-3 text-[11px] font-bold uppercase tracking-widest text-gray-500 [writing-mode:vertical-rl] rotate-180">Build</span>
      </aside>
    )
  }
  return (
    <aside className="w-[264px] shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden print-hide">
      <div className="flex items-center px-3.5 pt-3 pb-2 border-b border-gray-100 shrink-0">
        <span className="text-[11px] font-bold text-gray-600 uppercase tracking-widest flex-1">Build</span>
        <button onClick={() => setCollapsed(true)} title="Hide build panel" className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 flex">
          <span className="inline-block rotate-180"><Ic.ChevRight size={11} /></span><span className="inline-block rotate-180 -ml-1"><Ic.ChevRight size={11} /></span>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">{children}</div>
    </aside>
  )
}

function FieldBrowser({
  fields,
  source,
  onAdd,
  onRemove,
  onDupAlert,
  onDragStart,
  onDragEnd,
  timelineBlocked,
}: {
  fields: PivotFields
  source: string
  onAdd: (zone: PivotZoneKey, field: string, type: FieldType) => void
  onRemove: (zone: PivotZoneKey, id: string) => void
  onDupAlert: (field: string, count: number) => void
  onDragStart: (field: string, type: FieldType) => void
  onDragEnd: () => void
  /** Why the Timeline can't be used yet — it only ever acts on time-tracked metrics, so it is
      locked until the report has one. Null when it can. */
  timelineBlocked: string | null
}) {
  const [search, setSearch] = useState("")
  const [tlTipAt, setTlTipAt] = useState<{ x: number; y: number } | null>(null)
  const extras = useContext(ReportExtras)
  const allFormulas = useFormulas()
  const [formulasCollapsed, setFormulasCollapsed] = useState(false)
  // Only the source module starts expanded — everything else joined in is collapsed
  // until the user opens it, so switching source doesn't dump the whole catalog open.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    ;(SOURCE_MODULES[source] ?? [source]).forEach((m) => { if (m !== source) init[m] = true })
    return init
  })

  useEffect(() => {
    const init: Record<string, boolean> = {}
    ;(SOURCE_MODULES[source] ?? [source]).forEach((m) => { if (m !== source) init[m] = true })
    setCollapsed(init)
  }, [source])

  // Context menu
  const [showMenu, setShowMenu] = useState(false)
  const [showSortSub, setShowSortSub] = useState(false)
  const [sortMode, setSortMode] = useState("default")
  const [showInvolved, setShowInvolved] = useState(false)
  const [showFieldFilters, setShowFieldFilters] = useState(false)
  const [typeFilters, setTypeFilters] = useState<FieldType[]>([])
  const [onlyTimeTracked, setOnlyTimeTracked] = useState(false)

  const added = allAddedFields(fields)
  const allChips = [...fields.columns, ...fields.rows, ...fields.values]
  const fieldCount = (key: string) => allChips.filter((item) => item.field === key).length
  const query = search.trim().toLowerCase()
  // Searching opens every module it finds something in — a match hidden inside a collapsed
  // module reads as no match at all. The user can still fold one away mid-search; that is kept
  // apart from their normal open/closed choices, and forgotten when the search changes.
  const [searchCollapsed, setSearchCollapsed] = useState<Record<string, boolean>>({})
  useEffect(() => { setSearchCollapsed({}) }, [query])
  const isModuleCollapsed = (name: string) => (query ? !!searchCollapsed[name] : !!collapsed[name])
  const toggleModule = (name: string) => (query ? setSearchCollapsed : setCollapsed)((p) => ({ ...p, [name]: !p[name] }))

  // Only modules reachable from the current source are browsable — the source decides
  // which other modules can be joined in, the module itself decides what it contains.
  const reachableModules = SOURCE_MODULES[source] ?? [source]

  // Build module list with all filters + sorting applied — reachableModules is already in
  // "source module first, then joined modules" order, so preserve that instead of catalog order.
  let processedModules = reachableModules
    .map((name) => MODULES.find((m) => m.name === name))
    .filter((m): m is Module => !!m)
    .map((m) => {
    let mFields = m.fields
    // A search naming the module ("account") lists all of it; otherwise it matches field names.
    if (query && !m.name.toLowerCase().includes(query)) mFields = mFields.filter((f) => f.name.toLowerCase().includes(query))
    if (showInvolved) mFields = mFields.filter((f) => added.has(makeFieldKey(m.name, f.name)))
    if (typeFilters.length > 0) mFields = mFields.filter((f) => typeFilters.includes(f.type))
    if (onlyTimeTracked) mFields = mFields.filter((f) => TIMELINE_METRICS_SET.has(makeFieldKey(m.name, f.name)))
    if (sortMode === "name-asc") mFields = [...mFields].sort((a, b) => a.name.localeCompare(b.name))
    else if (sortMode === "name-desc") mFields = [...mFields].sort((a, b) => b.name.localeCompare(a.name))
    else if (sortMode === "type-asc") mFields = [...mFields].sort((a, b) => a.type.localeCompare(b.type))
    else if (sortMode === "type-desc") mFields = [...mFields].sort((a, b) => b.type.localeCompare(a.type))
    // Default order: category (attribute) fields first, metrics after — matches how BI tools
    // separate dimensions from measures. An explicit sort above fully overrides this instead.
    else mFields = [...mFields.filter((f) => !isNumericType(f.type)), ...mFields.filter((f) => isNumericType(f.type))]
    return { ...m, fields: mFields }
  }).filter((m) => m.fields.length > 0)

  if (sortMode === "table-asc") processedModules = [...processedModules].sort((a, b) => a.name.localeCompare(b.name))
  else if (sortMode === "table-desc") processedModules = [...processedModules].sort((a, b) => b.name.localeCompare(a.name))

  const hasActiveMenuOptions = sortMode !== "default" || showInvolved
  const hasActiveFieldFilters = typeFilters.length > 0 || onlyTimeTracked

  const handleFieldClick = (_e: React.MouseEvent, key: string, field: Field) => {
    const count = fieldCount(key)
    if (count > 1) {
      onDupAlert(key, count)
      return
    }
    if (count === 1) {
      for (const z of ["columns", "rows", "values"] as PivotZoneKey[]) {
        const item = fields[z].find((it) => it.field === key)
        if (item) { onRemove(z, item.id); break }
      }
    } else {
      const zone: PivotZoneKey = isNumericType(field.type) ? "values" : "rows"
      onAdd(zone, key, field.type)
    }
  }

  const toggleTypeFilter = (type: FieldType) =>
    setTypeFilters((prev) => prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type])

  const closeMenu = () => { setShowMenu(false); setShowSortSub(false) }

  const SORT_TABLE = [
    { key: "table-asc", label: "Sort Ascending" },
    { key: "table-desc", label: "Sort Descending" },
  ]
  const SORT_COLUMN = [
    { key: "name-asc", label: "By Name - Ascending" },
    { key: "name-desc", label: "By Name - Descending" },
    { key: "type-asc", label: "By Type - Ascending" },
    { key: "type-desc", label: "By Type - Descending" },
    { key: "default", label: "Default Sort" },
  ]

  return (
    <>
      <aside className="w-[260px] shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-hidden">
        {/* Header */}
        <div className="px-3.5 pt-3 pb-2 border-b border-gray-100">
          <p className="text-[11px] font-bold text-gray-600 uppercase tracking-widest mb-2">Fields</p>

          <div className="flex items-center gap-1.5">
            {/* Search */}
            <div className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-gray-200 bg-gray-50">
              <span className="text-gray-400 shrink-0"><Ic.Search /></span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields..."
                className="flex-1 min-w-0 text-[13px] text-gray-700 placeholder-gray-400 outline-none bg-transparent"
              />
            </div>

            {/* Dedicated filter button */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowFieldFilters((p) => !p)}
                title="Filter fields"
                className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors
                  ${showFieldFilters ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
              >
                <Ic.Filter />
                {hasActiveFieldFilters && !showFieldFilters && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-indigo-500" />
                )}
              </button>

              {showFieldFilters && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowFieldFilters(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-56">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pt-2 pb-1">Field type</p>
                    {(["number", "money", "hours", "percent", "date", "text", "person", "boolean"] as FieldType[]).map((type) => {
                      const checked = typeFilters.includes(type)
                      return (
                        <button
                          key={type}
                          onClick={() => toggleTypeFilter(type)}
                          className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                            ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}
                          >
                            {checked && (
                              <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                                <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </span>
                          <span className="text-gray-500 shrink-0">{fieldTypeIcon(type, 13)}</span>
                          <span className="flex-1 text-left capitalize">{type}</span>
                        </button>
                      )
                    })}
                    <div className="my-1 border-t border-gray-100" />
                    <button
                      onClick={() => setOnlyTimeTracked((p) => !p)}
                      className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                        ${onlyTimeTracked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}
                      >
                        {onlyTimeTracked && (
                          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                            <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </span>
                      <span className="text-amber-500 shrink-0"><Ic.Clock size={13} /></span>
                      <span className="flex-1 text-left">Time-tracked</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* ⋮ button */}
            <div className="relative shrink-0">
              <button
                onClick={() => { setShowMenu((p) => !p); setShowSortSub(false) }}
                className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors
                  ${showMenu ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
              >
                <Ic.DotsV />
                {hasActiveMenuOptions && !showMenu && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-indigo-500" />
                )}
              </button>

              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={closeMenu} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-52">

                    {/* Expand All */}
                    <button
                      onClick={() => { setCollapsed({}); closeMenu() }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-gray-500"><Ic.ExpandAll /></span>
                      <span>Expand All</span>
                    </button>

                    {/* Show Involved Columns */}
                    <button
                      onClick={() => { setShowInvolved((p) => !p); closeMenu() }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-gray-500"><Ic.Eye /></span>
                      <span className="flex-1 text-left">Show Involved Columns</span>
                      {showInvolved && <span className="text-indigo-500"><Ic.Check /></span>}
                    </button>

                    {/* Apply Sort with inline accordion */}
                    <button
                      onClick={() => setShowSortSub((p) => !p)}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 text-[13px] hover:bg-gray-50 transition-colors
                        ${sortMode !== "default" ? "text-indigo-600" : "text-gray-700"}`}
                    >
                      <span className="text-gray-500"><Ic.SortIcon /></span>
                      <span className="flex-1 text-left">Apply Sort</span>
                      {sortMode !== "default" && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-1 shrink-0" />}
                      <span className="text-gray-400">
                        {showSortSub ? <Ic.ChevDown size={12} /> : <Ic.ChevRight size={12} />}
                      </span>
                    </button>
                    {showSortSub && (
                      <div className="bg-gray-50 border-t border-b border-gray-100 py-1">
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-5 pt-2 pb-1">Sort Table</p>
                        {SORT_TABLE.map((opt) => (
                          <button key={opt.key}
                            onClick={() => { setSortMode(opt.key); closeMenu() }}
                            className={`flex items-center justify-between w-full px-5 py-1.5 text-[13px] hover:bg-indigo-50 transition-colors
                              ${sortMode === opt.key ? "text-indigo-600 font-medium" : "text-gray-700"}`}
                          >
                            {opt.label}
                            {sortMode === opt.key && <Ic.Check />}
                          </button>
                        ))}
                        <div className="my-1 border-t border-gray-100" />
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-5 pb-1">Sort Column</p>
                        {SORT_COLUMN.map((opt) => (
                          <button key={opt.key}
                            onClick={() => { setSortMode(opt.key); closeMenu() }}
                            className={`flex items-center justify-between w-full px-5 py-1.5 text-[13px] hover:bg-indigo-50 transition-colors
                              ${sortMode === opt.key ? "text-indigo-600 font-medium" : "text-gray-700"}`}
                          >
                            {opt.label}
                            {sortMode === opt.key && <Ic.Check />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Module tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {/* Timeline belongs to no module, so it sits above them all. Drop it in Rows or Columns
              to split time-tracked metrics by period, or in Filters to narrow them to one. */}
          {(search.trim() === "" || "timeline".includes(search.trim().toLowerCase())) && (() => {
            const inRows = fields.rows.find((it) => it.field === TIMELINE_KEY)
            const inColumns = fields.columns.find((it) => it.field === TIMELINE_KEY)
            // Once placed it can always be taken out again, even if its metrics have since gone.
            const locked = !!timelineBlocked && !inRows && !inColumns
            if (locked) {
              return (
                <div
                  aria-disabled
                  onMouseMove={(e) => setTlTipAt({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTlTipAt(null)}
                  className="flex items-center gap-2 mx-2 mb-1 px-2.5 py-1.5 rounded-md border border-gray-200 bg-gray-50
                    cursor-not-allowed select-none"
                >
                  <span className="shrink-0 text-gray-300"><Ic.Calendar /></span>
                  <span className="text-[13px] font-medium flex-1 text-gray-400">Timeline</span>
                  {tlTipAt && <CursorTooltip text={timelineBlocked!} at={tlTipAt} />}
                </div>
              )
            }
            return (
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/field", JSON.stringify({ field: TIMELINE_KEY, type: "date" }))
                  e.dataTransfer.effectAllowed = "copy"
                  onDragStart(TIMELINE_KEY, "date")
                }}
                onDragEnd={onDragEnd}
                onClick={() => inRows ? onRemove("rows", inRows.id)
                  : inColumns ? onRemove("columns", inColumns.id) : onAdd("columns", TIMELINE_KEY, "date")}
                title="Split time-tracked metrics by period (Rows or Columns), or narrow them to one (Filters)"
                className="flex items-center gap-2 mx-2 mb-1 px-2.5 py-1.5 rounded-md border border-sky-200 bg-sky-50/60
                  cursor-grab active:cursor-grabbing hover:bg-sky-100/70 transition-colors select-none"
              >
                <span className="shrink-0 text-sky-600"><Ic.Calendar /></span>
                <span className="text-[13px] font-medium flex-1 text-sky-800">Timeline</span>
                {(inRows || inColumns) && <span className="shrink-0 text-indigo-500"><Ic.Check /></span>}
              </div>
            )
          })()}
          {/* Formula fields saved for this source — today's "Formula Fields" group. They are
              numbers worked out from other fields, so they only ever go in Values. */}
          {(() => {
            const list = allFormulas.filter((f) => f.source === source
              && (!query || f.name.toLowerCase().includes(query) || "formula".includes(query)))
            if (list.length === 0 || showInvolved && !list.some((f) => added.has(formulaKeyOf(f)))) return null
            return (
              <div>
                <button onClick={() => setFormulasCollapsed((p) => !p)} className="flex items-center gap-1.5 w-full px-3 py-2 hover:bg-gray-50 transition-colors">
                  <span className="text-gray-400" style={{ transform: formulasCollapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>
                    <Ic.ChevDown />
                  </span>
                  <span className="text-gray-500"><FxIcon size={14} /></span>
                  <span className="text-[13px] font-medium text-gray-700 flex-1 text-left">Formula fields</span>
                  <span className="text-[11px] text-gray-400 tabular-nums">{list.length}</span>
                </button>
                {!formulasCollapsed && list.map((f) => {
                  const key = formulaKeyOf(f)
                  const isAdded = added.has(key)
                  return (
                    <div
                      key={key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/field", JSON.stringify({ field: key, type: "number" }))
                        e.dataTransfer.effectAllowed = "copy"
                        onDragStart(key, "number")
                      }}
                      onDragEnd={onDragEnd}
                      onClick={() => {
                        const placed = [...fields.values, ...fields.columns].find((it) => it.field === key)
                        if (placed) onRemove(fields.values.includes(placed) ? "values" : "columns", placed.id)
                        else onAdd("values", key, "number")
                      }}
                      className="flex items-center gap-2 pl-8 pr-2 py-1.5 cursor-grab active:cursor-grabbing hover:bg-indigo-50 transition-colors group select-none"
                    >
                      <span className="shrink-0 text-emerald-500"><FxIcon /></span>
                      <span className="text-[13px] flex-1 truncate text-gray-700">{f.name}</span>
                      <button onClick={(e) => { e.stopPropagation(); extras.openFormula(f) }} title="Edit formula field"
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-gray-700 shrink-0"><Ic.Pencil size={12} /></button>
                      <button onClick={(e) => { e.stopPropagation(); extras.deleteFormula(f) }} title="Delete formula field"
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 shrink-0"><Ic.Trash size={12} /></button>
                      {isAdded && <span className="text-indigo-500 shrink-0"><Ic.Check /></span>}
                    </div>
                  )
                })}
              </div>
            )
          })()}
          {processedModules.length === 0 ? (
            <p className="text-[12px] text-gray-400 text-center px-4 py-8 leading-relaxed">
              {showInvolved ? "No fields in use yet" : "No fields match your filters"}
            </p>
          ) : processedModules.map((mod) => {
            const isCollapsed = isModuleCollapsed(mod.name)
            const addedCount = mod.fields.filter((f) => added.has(makeFieldKey(mod.name, f.name))).length
            return (
              <div key={mod.name}>
                <button
                  onClick={() => toggleModule(mod.name)}
                  className="flex items-center gap-1.5 w-full px-3 py-2 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-gray-400" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>
                    <Ic.ChevDown />
                  </span>
                  <span className="text-gray-500">{moduleIcon(mod.iconType)}</span>
                  <span className="text-[13px] font-medium text-gray-700 flex-1 text-left">{mod.name}</span>
                  <span className="text-[11px] text-gray-400 tabular-nums">
                    {addedCount > 0 && <span className="text-indigo-400 font-medium">{addedCount}/</span>}
                    {mod.fields.length}
                  </span>
                </button>

                {!isCollapsed && mod.fields.map((field) => {
                  const key = makeFieldKey(mod.name, field.name)
                  const isAdded = added.has(key)
                  const count = fieldCount(key)
                  const isTimeTracked = TIMELINE_METRICS_SET.has(key)
                  return (
                    <div
                      key={key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/field", JSON.stringify({ field: key, type: field.type }))
                        e.dataTransfer.effectAllowed = "copy"
                        onDragStart(key, field.type)
                      }}
                      onDragEnd={onDragEnd}
                      onClick={(e) => handleFieldClick(e, key, field)}
                      className="flex items-center gap-2 pl-8 pr-3 py-1.5 cursor-grab active:cursor-grabbing
                        hover:bg-indigo-50 transition-colors group select-none"
                    >
                      <span className="shrink-0">{fieldTypeIcon(field.type)}</span>
                      <span className="text-[13px] flex-1 truncate text-gray-700">{field.name}</span>
                      {isTimeTracked && (
                        <span className="shrink-0 text-amber-500" title="Time-tracked field — supports date-range filtering">
                          <Ic.Clock size={11} />
                        </span>
                      )}
                      {isAdded ? (
                        <span className="shrink-0 flex items-center gap-1">
                          {count > 1 && (
                            <span className="text-[10px] font-semibold text-indigo-500 bg-indigo-50 rounded-full px-1.5 py-px">
                              ×{count}
                            </span>
                          )}
                          <span className="text-indigo-500 hover:text-red-400 transition-colors cursor-pointer" title="Remove field">
                            <Ic.Check />
                          </span>
                        </span>
                      ) : (
                        <span className="opacity-0 group-hover:opacity-100 text-gray-300 shrink-0 transition-opacity">
                          <Ic.GripVertical />
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </aside>

    </>
  )
}

// ── Drop zone bar ──────────────────────────────────────────────────────────────

interface DropZoneBarProps {
  source?: string
  fields: PivotFields
  dragging: boolean
  dragType: FieldType | null
  grainModule: string
  lookupPaths: Record<string, string>
  onLookupPathChange: (id: string, path: string) => void
  aggregations: Record<string, string>
  timelineFilters: Record<string, MetricFilter>
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  onDrop: (zone: PivotZoneKey, field: string, type: FieldType) => void
  onMove: (from: PivotZoneKey, to: PivotZoneKey, id: string) => void
  onReorder: (zone: PivotZoneKey, id: string, toIndex: number) => void
  onRemove: (zone: PivotZoneKey, id: string) => void
  onAggChange: (id: string, agg: string) => void
  onTimelineChange: (id: string, f: MetricFilter | null) => void
  onRangeConfigChange: (id: string, cfg: RangeConfig) => void
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
  blockReason?: (zone: PivotZoneKey, field: string, id?: string) => string | null
  notice?: string | null
}

function DropZoneBar(props: DropZoneBarProps) {
  const { source, fields, dragging, dragType, grainModule, lookupPaths, aggregations, timelineFilters, rangeConfigs, fieldFormats, onDrop, onMove, onReorder, onRemove, onAggChange, onLookupPathChange, onTimelineChange, onRangeConfigChange, onFieldFormatChange, blockReason, notice } = props

  const zones: { key: PivotZoneKey; label: string; suggestValues?: boolean }[] = [
    { key: "columns", label: "Columns" },
    { key: "rows", label: "Rows" },
    { key: "values", label: "Values", suggestValues: true },
  ]

  return (
    <div className="relative flex flex-col gap-2.5 print-hide">
      {notice && (
        <div role="status" className="absolute left-0 right-0 top-0 z-20 rounded-md bg-gray-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg">
          {notice}
        </div>
      )}
      {zones.map(({ key, label, suggestValues }) => (
        <DropZone
          key={key}
          zone={key}
          label={label}
          chips={fields[key]}
          dragging={dragging}
          isSuggested={!!suggestValues && !!dragType && isNumericType(dragType)}
          grainModule={grainModule}
          source={source}
          lookupPaths={lookupPaths}
          onLookupPathChange={onLookupPathChange}
          aggregations={aggregations}
          timelineFilters={timelineFilters}
          rangeConfigs={rangeConfigs}
          fieldFormats={fieldFormats}
          onDrop={onDrop}
          onMove={onMove}
          onReorder={onReorder}
          onRemove={onRemove}
          onAggChange={onAggChange}
          onTimelineChange={onTimelineChange}
          onRangeConfigChange={onRangeConfigChange}
          onFieldFormatChange={onFieldFormatChange}
          blockReason={blockReason}
        />
      ))}
    </div>
  )
}

// Generic over its zone key so each builder keeps its own narrow zone union end to end — the
// pivot's handlers index PivotFields, the tabular one's index TabularFields, and neither can be
// handed the other's zone by mistake.
function DropZone<Z extends ZoneKey>({
  zone, label, chips, dragging, isSuggested, grainModule, source, lookupPaths,
  aggregations, timelineFilters, rangeConfigs, fieldFormats, onDrop, onMove, onReorder, onRemove, onAggChange, onLookupPathChange, onTimelineChange, onRangeConfigChange, onFieldFormatChange, blockReason,
}: {
  zone: Z; label: string; chips: PivotItem[]; dragging: boolean
  isSuggested: boolean; aggregations: Record<string, string>
  /** The report's grain — a chip's relationship options depend on where it is resolved from. */
  grainModule: string
  /** The report's source: a Team member chip offers the roles of this module. */
  source?: string
  lookupPaths: Record<string, string>
  onLookupPathChange: (id: string, path: string) => void
  timelineFilters: Record<string, MetricFilter>
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  onDrop: (zone: Z, field: string, type: FieldType) => void
  onMove: (from: Z, to: Z, id: string) => void
  onReorder: (zone: Z, id: string, toIndex: number) => void
  onRemove: (zone: Z, id: string) => void
  onAggChange: (id: string, agg: string) => void
  onTimelineChange: (id: string, f: MetricFilter | null) => void
  onRangeConfigChange: (id: string, cfg: RangeConfig) => void
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
  /** Why the field being dragged can't land here (shown at the pointer), or null. */
  blockReason?: (zone: Z, field: string, id?: string) => string | null
}) {
  const [over, setOver] = useState(false)
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const [blocked, setBlocked] = useState<{ text: string; at: { x: number; y: number } } | null>(null)
  const extras = useContext(ReportExtras)

  // A cancelled drag never fires dragleave on the zone, so clear the "no" on any drag ending.
  useEffect(() => {
    const clear = () => setBlocked(null)
    document.addEventListener("dragend", clear)
    document.addEventListener("drop", clear)
    return () => { document.removeEventListener("dragend", clear); document.removeEventListener("drop", clear) }
  }, [])

  // Dragover fires many times a second, so each zone/field answer is worked out once per drag.
  const reasonFor = (): string | null => {
    if (!blockReason || !activeDrag) return null
    const key = `${zone}|${activeDrag.field}|${activeDrag.id ?? ""}`
    if (!dropReasonCache.has(key)) dropReasonCache.set(key, blockReason(zone, activeDrag.field, activeDrag.id))
    return dropReasonCache.get(key) ?? null
  }
  // True when the drop must be refused: shows the reason at the pointer and a no-drop cursor.
  const refuse = (e: React.DragEvent): boolean => {
    const reason = reasonFor()
    if (!reason) { if (blocked) setBlocked(null); return false }
    e.dataTransfer.dropEffect = "none"
    setOver(false); setInsertAt(null)
    setBlocked({ text: reason, at: { x: e.clientX, y: e.clientY } })
    return true
  }

  const parseField = (e: React.DragEvent) =>
    JSON.parse(e.dataTransfer.getData("application/field")) as {
      id?: string; field: string; type: FieldType; fromZone?: Z
    }

  const handleZoneDragOver = (e: React.DragEvent) => { e.preventDefault(); if (!refuse(e)) setOver(true) }
  const handleZoneDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setOver(false); setInsertAt(null); setBlocked(null)
    }
  }
  const handleZoneDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false); setInsertAt(null); setBlocked(null)
    if (reasonFor()) return
    try {
      const data = parseField(e)
      if (data.fromZone === zone && data.id) {
        onReorder(zone, data.id, chips.length)
      } else if (data.fromZone && data.id) {
        onMove(data.fromZone, zone, data.id)
      } else {
        onDrop(zone, data.field, data.type)
      }
    } catch {}
  }

  const handleChipDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault(); e.stopPropagation()
    if (!refuse(e)) { setOver(true); setInsertAt(index) }
  }
  const handleChipDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault(); e.stopPropagation()
    setOver(false); setInsertAt(null); setBlocked(null)
    if (reasonFor()) return
    try {
      const data = parseField(e)
      if (data.fromZone === zone && data.id) {
        onReorder(zone, data.id, index)
      } else if (data.fromZone && data.id) {
        onMove(data.fromZone, zone, data.id)
      } else {
        onDrop(zone, data.field, data.type)
      }
    } catch {}
  }

  const highlight = !blocked && (over || (dragging && isSuggested))
  const isEmpty = chips.length === 0

  return (
    <div
      onDragOver={handleZoneDragOver}
      onDragLeave={handleZoneDragLeave}
      onDrop={handleZoneDrop}
      className={`w-full rounded-lg flex flex-col transition-all
        ${blocked
          ? "border-2 border-dashed border-gray-300 bg-gray-100 opacity-60 cursor-not-allowed"
          : highlight
          ? "border-2 border-dashed border-indigo-300 bg-indigo-50"
          : isEmpty
            ? "border-2 border-dashed border-gray-200 bg-gray-50/60"
            : "border border-gray-200 bg-gray-50/60 shadow-sm"}`}
    >
      {blocked && <CursorTooltip text={blocked.text} at={blocked.at} />}
      {/* Zone label */}
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 shrink-0">
        <span className={`text-[11px] font-bold uppercase tracking-wider transition-colors
          ${highlight ? "text-indigo-500" : "text-gray-600"}`}>
          {label}
        </span>
        {chips.length > 0 && (
          <span className="text-[10px] bg-gray-200/70 text-gray-600 rounded-full px-1.5 py-px font-medium">
            {chips.length}
          </span>
        )}
        {extras.formulaZone === zone && (
          <button
            onClick={() => extras.openFormula()}
            title="New formula field"
            className="ml-auto flex items-center gap-1 text-[11px] font-medium text-indigo-600 border border-indigo-200 bg-white
              rounded-md px-1.5 py-0.5 hover:bg-indigo-50 transition-colors"
          >
            <FxIcon size={11} /> Formula
          </button>
        )}
      </div>

      {/* Chips — 1 per row, scrolls internally instead of growing the shelf */}
      <div className="px-3 pb-2.5 flex flex-col gap-1.5">
        {isEmpty ? (
          <span className={`text-[12px] transition-colors ${highlight ? "text-indigo-400" : "text-gray-300"}`}>
            {highlight ? "Release to add" : "Drop fields here"}
          </span>
        ) : (
          chips.map((item, index) => (
            <div
              key={item.id}
              onDragOver={(e) => handleChipDragOver(e, index)}
              onDrop={(e) => handleChipDrop(e, index)}
              className="flex flex-col gap-0 animate-chip-in shrink-0"
            >
              <div className={`h-0.5 rounded-full transition-all duration-150 mb-1
                ${insertAt === index ? "bg-indigo-500 scale-x-100" : "bg-transparent scale-x-0"}`}
              />
              <FieldChip
                id={item.id}
                name={item.field}
                zone={zone}
                modifier={aggregations[item.id]}
                lookupPath={lookupPaths[item.id]}
                lookupOptions={availableLookupPaths(grainModule, item.field, source)}
                onLookupPathChange={(path) => onLookupPathChange(item.id, path)}
                timelineFilter={timelineFilters[item.id]}
                rangeConfig={rangeConfigs[item.id]}
                fieldFormat={fieldFormats[item.id]}
                onRemove={() => onRemove(zone, item.id)}
                onModifierChange={(m) => onAggChange(item.id, m)}
                onTimelineChange={(f) => onTimelineChange(item.id, f)}
                onRangeConfigChange={(cfg) => onRangeConfigChange(item.id, cfg)}
                onFieldFormatChange={(patch) => onFieldFormatChange(item.id, patch)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Date granularity options (2-column grid)
const DATE_GRANULARITY: { label: string; example: string }[] = [
  { label: "Year",          example: "E.g., 2025, 2026" },
  { label: "Quarter & Year",example: "E.g., Q3 2026" },
  { label: "Quarter",       example: "E.g., Q1, Q2" },
  { label: "Month & Year",  example: "E.g., August 2026" },
  { label: "Month",         example: "E.g., January, February" },
  { label: "Week & Year",   example: "E.g., W32 2026" },
  { label: "Week",          example: "E.g., Week 1, Week 2" },
  { label: "Date",          example: "E.g., 3/8/2026" },
  { label: "Date & Time",   example: "E.g., 03 Aug 2026 00:00:07 hrs" },
]

function modifierOptions(zone: ZoneKey, fieldType: FieldType): string[] | null {
  if (zone === "values") {
    if (isNumericType(fieldType)) return AGG_OPTIONS
    return ["Count", "Distinct Count"]
  }
  // A tabular column shows the record's own value — nothing to modify.
  if (zone === "tabColumns") return null
  if (zone === "columns" || zone === "rows" || zone === "tabGroupBy") {
    // Grouping a measure is only meaningful as exact values or bands, in either builder.
    if (isNumericType(fieldType)) return ["Dimension", "Range"]
    if (fieldType === "date") return null // handled separately with date granularity picker
  }
  return null // text / person / boolean used for grouping: no badge
}

function MetricDatePicker({ filter, onChange, onClose }: {
  filter: MetricFilter
  onChange: (f: MetricFilter) => void
  onClose: () => void
}) {
  const [calNav, setCalNav] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() - 1 })
  const isCustom = filter.period === "custom"

  const applyPreset = (p: string) => { onChange({ ...filter, period: p, customFrom: "", customTo: "" }); onClose() }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden w-56">
      {!isCustom ? (
        <div className="overflow-y-auto max-h-80 py-1">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pt-2 pb-1">Presets</p>
          {DATE_PRESETS.map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`flex items-center justify-between w-full px-3 py-1.5 text-[12px] transition-colors
                ${filter.period === p ? "bg-indigo-50 text-indigo-600 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
            >
              {p}{filter.period === p && <Ic.Check />}
            </button>
          ))}
          <div className="border-t border-gray-100 my-1" />
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pb-1">Relative</p>
          {DASH_FILTER_RELATIVE.map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-[12px] transition-colors
                ${filter.period === p ? "bg-indigo-50 text-indigo-600" : "text-gray-700 hover:bg-gray-50"}`}
            >
              <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center
                ${filter.period === p ? "border-indigo-600" : "border-gray-300"}`}>
                {filter.period === p && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
              </span>{p}
            </button>
          ))}
          <div className="border-t border-gray-100 my-1" />
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pb-1">Absolute</p>
          {DASH_FILTER_ABSOLUTE.map(p => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`flex items-center gap-2 w-full px-3 py-1.5 text-[12px] transition-colors
                ${filter.period === p ? "bg-indigo-50 text-indigo-600" : "text-gray-700 hover:bg-gray-50"}`}
            >
              <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center
                ${filter.period === p ? "border-indigo-600" : "border-gray-300"}`}>
                {filter.period === p && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
              </span>{p}
            </button>
          ))}
          <div className="border-t border-gray-100 my-1" />
          <button onClick={() => onChange({ ...filter, period: "custom" })}
            className="flex items-center justify-between w-full px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 transition-colors">
            Custom range <Ic.ChevRight size={11} />
          </button>
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">From</label>
              <input type="date" value={filter.customFrom}
                onChange={e => onChange({ ...filter, customFrom: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-[12px] focus:outline-none focus:border-indigo-400" />
            </div>
            <span className="text-gray-300 mt-4 text-[11px]">→</span>
            <div className="flex-1">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">To</label>
              <input type="date" value={filter.customTo}
                onChange={e => onChange({ ...filter, customTo: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-[12px] focus:outline-none focus:border-indigo-400" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setCalNav(n => { const d = new Date(n.year, n.month - 1); return { year: d.getFullYear(), month: d.getMonth() } })}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg></button>
            <button onClick={() => setCalNav(n => { const d = new Date(n.year, n.month + 1); return { year: d.getFullYear(), month: d.getMonth() } })}
              className="p-1 rounded hover:bg-gray-100 text-gray-500"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg></button>
          </div>
          <CalendarMonth year={calNav.year} month={calNav.month}
            from={filter.customFrom} to={filter.customTo}
            onDay={iso => {
              if (!filter.customFrom || (filter.customFrom && filter.customTo)) onChange({ ...filter, customFrom: iso, customTo: "" })
              else if (iso < filter.customFrom) onChange({ ...filter, customFrom: iso, customTo: filter.customFrom })
              else onChange({ ...filter, customTo: iso })
            }} />
          <div className="flex items-center justify-between pt-1 border-t border-gray-100">
            <button onClick={() => onChange({ ...filter, period: "Last 12 months" })}
              className="text-[11px] text-gray-400 hover:text-gray-600">← Presets</button>
            <button onClick={onClose}
              className="px-3 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors">Apply</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ChipPortalMenu({ anchorRef, onClose, children }: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: React.ReactNode
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!anchorRef.current) return
    const margin = 8
    const anchor = anchorRef.current.getBoundingClientRect()
    const menu = menuRef.current?.getBoundingClientRect()

    let left = anchor.left
    let top = anchor.bottom

    if (menu) {
      if (left + menu.width > window.innerWidth - margin) {
        left = Math.max(margin, anchor.right - menu.width)
      }
      if (top + menu.height > window.innerHeight - margin) {
        top = Math.max(margin, anchor.top - menu.height)
      }
    }

    setPos({ top: top + window.scrollY, left: left + window.scrollX })
  }, [anchorRef])

  // The menu renders into document.body via a portal, so it's never a DOM
  // descendant of the chip that anchors it — a mousedown here would look
  // "outside" to any listener scoped to the chip. Close only for clicks
  // that land outside both the menu itself and its anchor button (the
  // anchor's own onClick already handles toggling on repeat clicks).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [anchorRef, onClose])

  return createPortal(
    <div ref={menuRef} style={{ position: "absolute", top: pos.top, left: pos.left, zIndex: 9999 }}>
      {children}
    </div>,
    document.body
  )
}

// A numeric Row/Column field in "Range" mode buckets by this config. "Equal window" (default)
// splits the observed min–max span into fixed-size windows — the user sets the window's size,
// not how many of them there are (matching Excel's own PivotTable numeric grouping UI, which
// asks for an interval, not a bucket count). "Custom window" instead bands by user-chosen
// boundary edges, live-previewed here the same way rangeBucketLabel renders them: everything
// below the first edge, everything at/above the last, one band between each adjacent pair.
// `embedded` drops the outer card chrome for when this renders inside another dropdown/card.
function RangeConfigPicker({ config, bounds, type, onChange, embedded }: {
  config: RangeConfig
  bounds: { min: number; max: number }
  type: FieldType
  onChange: (patch: Partial<RangeConfig>) => void
  embedded?: boolean
}) {
  const mode = config.mode ?? "equal"
  const fmt = (v: number) => type === "percent" ? `${Math.round(v)}%` : type === "money" ? `$${formatMoneyish(v)}` : type === "hours" ? `${formatMoneyish(v)}h` : formatMoneyish(v)
  const span = Math.max(1, bounds.max - bounds.min)
  const bucketSize = config.bucketSize && config.bucketSize > 0 ? config.bucketSize : niceBucketSize(span)
  const bucketCountEstimate = Math.max(1, Math.ceil(span / bucketSize))
  const customBounds = config.customBounds ?? []
  const sortedBounds = [...customBounds].sort((a, b) => a - b)

  const updateBound = (i: number, v: number) => {
    const next = [...customBounds]; next[i] = v; onChange({ customBounds: next })
  }
  const addBound = () => {
    const base = sortedBounds.length ? sortedBounds[sortedBounds.length - 1] : bounds.min
    const step = Math.max(1, Math.round((bounds.max - bounds.min) / 5))
    onChange({ customBounds: [...customBounds, Math.round((base + step) * 100) / 100] })
  }
  const removeBound = (i: number) => onChange({ customBounds: customBounds.filter((_, idx) => idx !== i) })

  const previewBands = sortedBounds.length === 0 ? [] : [
    `< ${fmt(sortedBounds[0])}`,
    ...sortedBounds.slice(0, -1).map((b, i) => `${fmt(b)} – ${fmt(sortedBounds[i + 1])}`),
    `${fmt(sortedBounds[sortedBounds.length - 1])}+`,
  ]

  return (
    <div className={embedded ? "" : "bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden w-64"}>
      <div className={`flex items-center rounded-md border border-gray-200 p-0.5 mb-2 ${embedded ? "mt-1" : "m-2.5"}`}>
        <button
          onClick={() => onChange({ mode: "equal" })}
          className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors
            ${mode === "equal" ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
        >
          Equal window
        </button>
        <button
          onClick={() => onChange({ mode: "custom" })}
          className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors
            ${mode === "custom" ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
        >
          Custom window
        </button>
      </div>

      {mode === "equal" ? (
        <div className={`flex flex-col gap-1.5 ${embedded ? "" : "px-3 pb-3"}`}>
          <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Window size</label>
          <input
            type="number" min={0} step="any" value={bucketSize}
            onChange={(e) => onChange({ bucketSize: Math.max(0.01, Number(e.target.value) || bucketSize) })}
            className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
          />
          <p className="text-[11px] text-gray-400">
            Splits {fmt(bounds.min)} – {fmt(bounds.max)} into windows of {fmt(bucketSize)} each (~{bucketCountEstimate} buckets).
          </p>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 max-h-72 overflow-y-auto ${embedded ? "" : "px-3 pb-3"}`}>
          {customBounds.length === 0 && (
            <p className="text-[11px] text-gray-400">No boundaries yet — add one to start splitting the range.</p>
          )}
          {customBounds.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="number" value={b}
                onChange={(e) => updateBound(i, Number(e.target.value))}
                className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
              />
              <button onClick={() => removeBound(i)} className="text-gray-300 hover:text-gray-600 p-1 shrink-0">
                <Ic.X size={12} />
              </button>
            </div>
          ))}
          <button onClick={addBound} className="text-[12px] text-indigo-500 hover:text-indigo-700 font-medium text-left">
            + Add boundary
          </button>
          {previewBands.length > 0 && (
            <div className="border-t border-gray-100 pt-2 mt-1 flex flex-col gap-0.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Preview</p>
              {previewBands.map((b, i) => <span key={i} className="text-[12px] text-gray-600 tabular-nums">{b}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The roles a field can be read through: every Team member role of the report's source, in one
// list.
function RoleMenuList({ title, options, current, onPick }: {
  title: string; options: string[]; current: string; onPick: (id: string) => void
}) {
  return (
    <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl py-1 w-60 max-h-[360px] overflow-y-auto">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 pt-1.5 pb-1">{title}</p>
      {options.map((o) => {
        return (
          <button
            key={o}
            onClick={() => onPick(o)}
            className={`flex items-center justify-between gap-2 w-full px-3 py-1.5 text-[13px] text-left hover:bg-sky-50 transition-colors
              ${current === o ? "text-sky-700 font-medium" : "text-gray-700"}`}
          >
            <span className="min-w-0">
              <span className="block truncate">{roleDisplayName(o)}</span>
            </span>
            {current === o && <Ic.Check />}
          </button>
        )
      })}
    </div>
  )
}

function FieldChip({ id, name, zone, modifier, lookupPath, lookupOptions, timelineFilter, rangeConfig, fieldFormat, onRemove, onModifierChange, onLookupPathChange, onTimelineChange, onRangeConfigChange, onFieldFormatChange }: {
  id: string; name: string; zone: ZoneKey; modifier?: string
  /** The relationship this chip resolves through, when its module can be reached more than one way. */
  lookupPath?: string
  lookupOptions?: string[]
  onLookupPathChange?: (path: string) => void
  timelineFilter?: MetricFilter
  rangeConfig?: RangeConfig
  fieldFormat?: FieldFormat
  onRemove: () => void
  onModifierChange: (m: string) => void
  onTimelineChange?: (f: MetricFilter | null) => void
  onRangeConfigChange?: (cfg: RangeConfig) => void
  onFieldFormatChange?: (patch: Partial<FieldFormat>) => void
}) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showRangeSettings, setShowRangeSettings] = useState(false)
  const [showFormatMenu, setShowFormatMenu] = useState(false)
  const [showLookupMenu, setShowLookupMenu] = useState(false)
  const lookupBtnRef = useRef<HTMLButtonElement>(null)
  const chosenRole = normalizeRoleId(lookupPath)
  const shownRole = lookupOptions && lookupOptions.length > 0
    ? (chosenRole && lookupOptions.includes(chosenRole) ? chosenRole : defaultLookupPath(lookupOptions))
    : undefined
  const modifierBtnRef = useRef<HTMLButtonElement>(null)
  const dateBtnRef = useRef<HTMLButtonElement>(null)
  const formatBtnRef = useRef<HTMLButtonElement>(null)
  const fieldType = getFieldType(name)
  const isFormula = isFormulaKey(name)
  // A formula decides its own maths, so it has no aggregation to pick.
  const options = isFormula ? null : modifierOptions(zone, fieldType)
  const extras = useContext(ReportExtras)
  const highlightable = (zone === "values" || zone === "tabColumns") && isNumericType(fieldType) && extras.formulaZone !== null
  const ruleCount = extras.highlightRules.filter((r) => r.fieldName === name).length
  const isDateDimension = (zone === "columns" || zone === "rows" || zone === "tabGroupBy") && fieldType === "date"
  // A flat table has no Values shelf, so a tabular column's default alignment follows the field
  // type instead: measures right, everything else left.
  const defaultAlign: "left" | "right" =
    zone === "values" || (zone === "tabColumns" && isNumericType(fieldType)) ? "right" : "left"
  const hasBadge = options !== null || isDateDimension
  const isTimelineMetric = zone === "values" && TIMELINE_METRICS_SET.has(name)
  // A Values chip keeps its aggregation (Sum, Count, …) inside the gear menu, not as a badge.
  const aggInGear = zone === "values" && options !== null && !!onFieldFormatChange
  // Rows/Columns chips do the same with their grouping (date grain, each value vs ranges).
  const groupInGear = (zone === "rows" || zone === "columns" || zone === "tabGroupBy")
    && (options !== null || isDateDimension) && !!onFieldFormatChange
  const settingsInGear = aggInGear || groupInGear
  const grainOptions = DATE_GRANULARITY.filter((opt) => name !== TIMELINE_KEY || TIMELINE_GRANULARITIES.includes(opt.label))
  const NUMERIC_GROUP_LABEL: Record<string, string> = { Dimension: "Each value", Range: "Ranges" }

  const currentFilter: MetricFilter = timelineFilter ?? { period: "", customFrom: "", customTo: "" }
  const currentRangeConfig: RangeConfig = rangeConfig ?? { mode: "equal", bucketSize: 0, customBounds: [] }

  const closeModifierDropdown = () => { setShowDropdown(false); setShowRangeSettings(false) }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          "application/field",
          JSON.stringify({ id, field: name, type: fieldType, fromZone: zone })
        )
        e.dataTransfer.effectAllowed = "move"
        startDrag(name, id)
      }}
      onDragEnd={endDrag}
      className="relative flex items-center gap-1.5 pl-2.5 pr-1 py-1 bg-white border border-gray-200
        rounded-md text-[12px] text-gray-700 shadow-sm hover:border-gray-300 transition-colors group
        cursor-grab active:cursor-grabbing active:opacity-50 active:shadow-none w-full min-w-0"
    >
      {/* Field name — flex-1 so it takes up space but yields to right-side controls.
          Title shows the owning module too, since the same short name (e.g. "Status")
          can exist on more than one module in the real schema. */}
      {isFormula && <span className="shrink-0 text-emerald-500" title="Formula field"><FxIcon size={12} /></span>}
      <span className="truncate flex-1 min-w-0" title={isFormula ? fieldDisplayName(name) : name.replace("::", ": ")}>{fieldDisplayName(name)}</span>

      {/* Relationship role — shown only when this field's module can be reached more than one
          way, so the 99 unambiguous relationships stay uncluttered. Always visible once it
          applies: two identical-looking chips resolving through different people is exactly
          the thing that must not be hidden behind a menu. */}
      {lookupOptions && lookupOptions.length > 1 && (
        <>
          <button
            ref={lookupBtnRef}
            onClick={(e) => { e.stopPropagation(); setShowLookupMenu((p) => !p) }}
            title={`Resolved via ${roleDisplayName(shownRole!)} — click to change`}
            className="flex items-center gap-0.5 text-[11px] font-medium text-sky-700
              bg-sky-50 border border-sky-200 rounded px-1.5 py-px hover:bg-sky-100 transition-colors shrink-0"
          >
            <span className="max-w-[120px] truncate">{roleDisplayName(shownRole!)}</span>
            <Ic.ChevDown size={9} />
          </button>
          {showLookupMenu && (
            <ChipPortalMenu anchorRef={lookupBtnRef} onClose={() => setShowLookupMenu(false)}>
              <RoleMenuList
                title="Resolve this field via"
                options={lookupOptions}
                current={shownRole!}
                onPick={(opt) => { onLookupPathChange?.(opt); setShowLookupMenu(false) }}
              />
            </ChipPortalMenu>
          )}
        </>
      )}

      {/* Modifier badge (Sum ∨, Count ∨, etc.) */}
      {hasBadge && modifier && !settingsInGear && (
        <button
          ref={modifierBtnRef}
          onClick={() => { setShowDropdown((p) => !p); setShowRangeSettings(false) }}
          className="flex items-center gap-0.5 text-[11px] font-semibold text-indigo-500
            bg-indigo-50 rounded px-1.5 py-px hover:bg-indigo-100 transition-colors shrink-0"
        >
          <span className="max-w-[52px] truncate">{modifier}</span>
          <Ic.ChevDown size={9} />
        </button>
      )}

      {/* Timeline calendar button + period badge — merged into one clickable button so the
          period label itself (not just the small calendar icon next to it) reopens the date
          picker once a period is set; previously the label was inert text, which read as
          "locked" since it's the more visually prominent part of the two. */}
      {isTimelineMetric && (
        <button
          ref={dateBtnRef}
          onClick={(e) => { e.stopPropagation(); setShowDatePicker(p => !p) }}
          title="Set date filter"
          className={`flex items-center gap-1 shrink-0 rounded transition-colors p-px
            ${currentFilter.period ? "text-indigo-600" : "text-gray-300 hover:text-gray-400"}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="3" y="4" width="18" height="18" rx="2.5"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {currentFilter.period && (
            <span className="text-[10px] font-medium truncate max-w-[56px]">
              {currentFilter.period === "custom"
                ? (currentFilter.customFrom && currentFilter.customTo
                    ? `${currentFilter.customFrom.slice(5)} – ${currentFilter.customTo.slice(5)}`
                    : "Custom")
                : currentFilter.period}
            </span>
          )}
        </button>
      )}

      {/* Format gear — opens the same rename/alignment/decimals/units controls as the
          settings-panel's Formatting subsection, scoped to just this field instance. Kept
          as its own icon rather than nested inside the modifier dropdown, per explicit
          request ("gear icon in the chip level too") as an additional access point. */}
      {onFieldFormatChange && (
        <button
          ref={formatBtnRef}
          onClick={(e) => { e.stopPropagation(); setShowFormatMenu((p) => !p) }}
          title={settingsInGear ? `${modifier ?? "Settings"} · format` : "Format field"}
          className={`transition-colors shrink-0 p-0.5 rounded hover:bg-gray-100
            ${settingsInGear ? (showFormatMenu ? "text-indigo-600" : "text-gray-400 hover:text-gray-600") : "text-gray-300 hover:text-gray-600 opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        >
          <Ic.Gear size={12} />
        </button>
      )}

      <button
        onClick={onRemove}
        className="text-gray-300 hover:text-gray-600 transition-colors shrink-0 p-0.5 rounded hover:bg-gray-100"
      >
        <Ic.X size={11} />
      </button>

      {/* Format popover — portalled below the gear icon */}
      {showFormatMenu && onFieldFormatChange && (
        <ChipPortalMenu anchorRef={formatBtnRef} onClose={() => setShowFormatMenu(false)}>
          <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-xl w-72 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50">
              <Ic.Gear size={12} />
              <span className="text-[12px] font-semibold text-gray-800 flex-1 truncate">{zone === "values" ? "Value settings" : "Field settings"}</span>
              <button onClick={() => setShowFormatMenu(false)} aria-label="Close" className="text-gray-400 hover:text-gray-700 transition-colors">
                <Ic.X size={12} />
              </button>
            </div>
            <div className="p-3">
            {aggInGear && options && (
              <div className="mb-3 pb-3 border-b border-gray-100">
                <p className={SETTINGS_SECTION}>Calculate</p>
                <label className={SETTINGS_LABEL}>Aggregation</label>
                <SettingsSelect value={modifier ?? options[0]} onChange={onModifierChange} ariaLabel="Aggregation">
                  {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </SettingsSelect>
              </div>
            )}
            {groupInGear && (
              <div className="mb-3 pb-3 border-b border-gray-100">
                <p className={SETTINGS_SECTION}>Group</p>
                {isDateDimension ? (
                  <>
                    <label className={SETTINGS_LABEL}>Date grain</label>
                    <SettingsSelect value={modifier ?? grainOptions[0].label} onChange={onModifierChange} ariaLabel="Date grain">
                      {grainOptions.map((g) => <option key={g.label} value={g.label}>{g.label}</option>)}
                    </SettingsSelect>
                    <p className="text-[11px] text-gray-400 mt-1">
                      {grainOptions.find((g) => g.label === modifier)?.example}
                    </p>
                  </>
                ) : options && (
                  <>
                    <label className={SETTINGS_LABEL}>Group values by</label>
                    <SettingsSelect value={modifier ?? options[0]} onChange={onModifierChange} ariaLabel="Group values by">
                      {options.map((opt) => <option key={opt} value={opt}>{NUMERIC_GROUP_LABEL[opt] ?? opt}</option>)}
                    </SettingsSelect>
                    {modifier === "Range" && onRangeConfigChange && (
                      <div className="mt-2.5">
                        <RangeConfigPicker
                          config={currentRangeConfig}
                          bounds={numericFieldBounds(name)}
                          type={fieldType}
                          onChange={(patch) => onRangeConfigChange({ ...currentRangeConfig, ...patch })}
                          embedded
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {isFormula && formulaOf(name) && (
              <div className="mb-3 pb-3 border-b border-gray-100">
                <p className={SETTINGS_SECTION}>Formula</p>
                <button
                  onClick={() => { setShowFormatMenu(false); extras.openFormula(formulaOf(name)) }}
                  className="w-full flex items-center gap-2 border border-gray-200 rounded-md px-2 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                >
                  <span className="text-gray-400"><FxIcon size={13} /></span>
                  <span className="flex-1 text-left">Edit formula field</span>
                  <Ic.ChevRight size={10} />
                </button>
              </div>
            )}
            {highlightable && (
              <div className="mb-3 pb-3 border-b border-gray-100">
                <p className={SETTINGS_SECTION}>Highlight</p>
                <button
                  onClick={() => { setShowFormatMenu(false); extras.openHighlight(name) }}
                  className="w-full flex items-center gap-2 border border-gray-200 rounded-md px-2 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                >
                  <span className="text-gray-400"><BrushIcon size={13} /></span>
                  <span className="flex-1 text-left">Highlight rules</span>
                  <span className="text-[11px] text-gray-400">{ruleCount > 0 ? ruleCount : "None"}</span>
                  <Ic.ChevRight size={10} />
                </button>
              </div>
            )}
            {(settingsInGear || highlightable || isFormula) && <p className={SETTINGS_SECTION}>Display</p>}
            <FieldFormatFields
              item={{ id, field: name }}
              defaultAlign={defaultAlign}
              format={fieldFormat ?? DEFAULT_FIELD_FORMAT}
              onChange={onFieldFormatChange}
            />
            </div>
          </div>
        </ChipPortalMenu>
      )}

      {/* Simple options dropdown — portalled below modifier badge. For a numeric Row/Column
          field, the "Range" row carries a settings icon that toggles a flyout sub-pane with
          the window-size settings — collapsed by default, never auto-opened just because
          Range is the active modifier. Kept in the SAME portal as the option list (rather than
          a second independent ChipPortalMenu) so a click inside the flyout is still "inside"
          this menu's own outside-click check, instead of closing the whole dropdown. */}
      {showDropdown && options && (
        <ChipPortalMenu anchorRef={modifierBtnRef} onClose={closeModifierDropdown}>
          <div className="relative mt-1">
            <div className="bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-36">
              {options.map((opt) => (
                <div key={opt} className="flex items-center">
                  <button
                    onClick={() => {
                      onModifierChange(opt)
                      if (opt !== "Range") setShowDropdown(false)
                    }}
                    className={`flex-1 flex items-center justify-between px-3 py-1.5 text-[13px] text-left hover:bg-indigo-50 transition-colors
                      ${modifier === opt ? "text-indigo-600 font-medium" : "text-gray-700"}`}
                  >
                    {opt}
                    {modifier === opt && <Ic.Check />}
                  </button>
                  {opt === "Range" && modifier === "Range" && onRangeConfigChange && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowRangeSettings((p) => !p) }}
                      title="Customize range buckets"
                      className={`p-1.5 mr-1 rounded transition-colors shrink-0
                        ${showRangeSettings ? "text-indigo-600 bg-indigo-50" : "text-gray-400 hover:text-indigo-600 hover:bg-indigo-50"}`}
                    >
                      <Ic.Sliders size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Range window-size sub pane — flyout beside the dropdown, opened only via the icon */}
            {showRangeSettings && modifier === "Range" && onRangeConfigChange && (
              <div className="absolute top-0 left-full ml-1.5 bg-white border border-gray-200 rounded-lg shadow-xl w-64 p-2.5">
                <RangeConfigPicker
                  config={currentRangeConfig}
                  bounds={numericFieldBounds(name)}
                  type={fieldType}
                  onChange={(patch) => onRangeConfigChange({ ...currentRangeConfig, ...patch })}
                  embedded
                />
              </div>
            )}
          </div>
        </ChipPortalMenu>
      )}

      {/* Date granularity picker — portalled below modifier badge */}
      {showDropdown && isDateDimension && (
        <ChipPortalMenu anchorRef={modifierBtnRef} onClose={() => setShowDropdown(false)}>
          <div className="bg-white border border-gray-200 rounded-xl shadow-2xl py-1 w-56 mt-1">
            <div className="flex flex-col">
              {/* A Timeline steps forward through time; seasonal buckets ("Month" without a year)
                  would fold every January into one column, which is not a timeline. */}
              {DATE_GRANULARITY.filter((opt) => name !== TIMELINE_KEY || TIMELINE_GRANULARITIES.includes(opt.label)).map((opt) => {
                const isActive = modifier === opt.label
                return (
                  <button
                    key={opt.label}
                    onClick={() => { onModifierChange(opt.label); setShowDropdown(false) }}
                    className={`text-left px-3 py-2 transition-colors
                      ${isActive ? "bg-indigo-600 text-white" : "hover:bg-gray-50 text-gray-800"}`}
                  >
                    <p className={`text-[13px] font-semibold ${isActive ? "text-white" : "text-gray-800"}`}>{opt.label}</p>
                    <p className={`text-[11px] ${isActive ? "text-indigo-200" : "text-gray-400"}`}>{opt.example}</p>
                  </button>
                )
              })}
            </div>
          </div>
        </ChipPortalMenu>
      )}

      {/* Metric date picker — portalled below calendar button */}
      {showDatePicker && isTimelineMetric && onTimelineChange && (
        <ChipPortalMenu anchorRef={dateBtnRef} onClose={() => setShowDatePicker(false)}>
          <div className="mt-1">
            <MetricDatePicker
              filter={currentFilter}
              onChange={(f) => onTimelineChange(f)}
              onClose={() => setShowDatePicker(false)}
            />
          </div>
        </ChipPortalMenu>
      )}

    </div>
  )
}

// ── Filter bar ─────────────────────────────────────────────────────────────────

type FilterOperator = string

interface FilterRule {
  field: string
  type: FieldType
  /** Which relationship this filter reads the field through, when it can be reached more than
      one way — the filter-side twin of a chip's role. Absent means the primary path. */
  lookupPath?: string
  /** Timeline filter only: metric chips (by id) the user unticked. Stored as exemptions rather
      than inclusions so a metric dropped later is covered by default. */
  tlExempt?: string[]
  operator: FilterOperator
  value: string
  value2: string   // for "between" ranges
  values: string[] // for multi-select picker
  // date-specific
  dateMode: "actual" | "range" | "relative"
  dateGranularity: string
  dateRangeOp: "after" | "before" | "between"
  dateFrom: string
  dateTo: string
  dateRelativeOpt: string
  dateRelativeN: number
  dateIncludeNull: boolean
  // text/person-specific — categorical filter modal (Actual / Wildcard tabs)
  catMode: "actual" | "wildcard"
  // Actual-tab set operator, meaningful only when catMode==="actual" && catTreatment==="categorical".
  // "any"/"none" are row-level (unchanged narrowing behavior; "none" replaces the old
  // excludeSelected flag). "all"/"only" are group-level ("HAVING"-style): they decide which of
  // the REPORT'S OWN pivot-row groups survive (every/exactly the checked values must appear
  // among that group's rows for this field) without ever dropping rows from a surviving
  // group — so its Values totals still reflect the whole group, not just the checked values.
  catMatchMode: CatMatchMode
  wildcardConditions: { matchType: WildcardMatchType; value: string }[]
  wildcardIncludeEmpty: boolean
  // text/person-specific — how the field is treated for filtering purposes. "categorical"
  // (default) filters raw rows by the field's own value (catMode above applies). "count" /
  // "distinctCount" instead filter the REPORT'S OWN pivot rows by a group-level aggregate of
  // this field (Count or Distinct Count, computed the same way a Values chip would) — a
  // "HAVING"-style filter that runs after grouping, not per raw row. Reuses numMode/
  // relativeDirection/relativeN/values/value/value2 below, same as a numeric filter.
  catTreatment: "categorical" | "count" | "distinctCount"
  // numeric-specific — which of the Values bucket's 6 aggregate functions (AGG_OPTIONS) this
  // filter is built on. A numeric field dropped into Filters is ALWAYS group-level: it filters
  // the REPORT'S OWN pivot rows by this function's aggregate of the field (same computation a
  // Values chip would do, via aggregateBucket), never the field's own raw per-row value — the
  // "Function" super-category the NumericFilterModal's header selects.
  numFunction: string
  // numeric filter modal (Actual / Range / Relative tabs). "range" reuses value/value2 above
  // as [lo, hi]; "actual" reuses values above as the checked number set. Also reused by a
  // categorical field's Count/Distinct-Count treatment (see catTreatment).
  numMode: "actual" | "range" | "relative"
  relativeDirection: "Top" | "Bottom"
  relativeN: number
  // ── View-filter presentation ──────────────────────────────────────────────────
  // Only meaningful for a rule in the View filters pane, which renders as an always-visible
  // inline control rather than a chip + modal. Harmless defaults on a base-Filters rule.
  // Deliberately narrower than the base filter modals: no wildcard, no single-value slider,
  // no Top-N — a viewer picks values or a range, nothing more.
  vfDisplayName: string                       // "" = use the field's own name
  vfComponent: ViewFilterComponent | ""       // "" = the field type's default component
  vfListMode: "all" | "selected"              // offer every value, or only vfOfferedValues
  vfOfferedValues: string[]                   // the builder's allow-list when vfListMode="selected"
  /** Range view filters: the dates a viewer may pick between. "any" (default) = no limit. */
  vfRangeLimit?: "any" | "specified"
  vfRangeFrom?: string
  vfRangeTo?: string
}

// How a view filter draws itself. The first group applies to text/person/boolean/date fields,
// the second to numeric ones; `viewFilterComponents` maps a field type to its valid options.
type ViewFilterComponent =
  | "singleList" | "singleDropdown" | "multiList" | "multiDropdown" | "multiCustomList"
  | "sliderDouble" | "multiSelectBox"

// View filters are always dropdowns (decided 2026-11-13); the list and custom-list styles are
// retired, and a saved rule that still names one is read as its dropdown counterpart.
const VF_CATEGORICAL_COMPONENTS: { key: ViewFilterComponent; label: string }[] = [
  { key: "singleDropdown", label: "One value" },
  { key: "multiDropdown", label: "Multiple values" },
]
const VF_NUMERIC_COMPONENTS: { key: ViewFilterComponent; label: string }[] = [
  { key: "sliderDouble", label: "Range slider" },
  { key: "multiSelectBox", label: "Dropdown of values" },
]
// A date's values are period labels, so it reuses the same select/list widgets under the
// reference's "…Select Box" naming. Which periods those are comes from the granularity
// dropdown; whether the viewer picks periods at all comes from dateMode (see VF_DATE_PERIODS).
const VF_DATE_COMPONENTS: { key: ViewFilterComponent; label: string }[] = [
  { key: "singleDropdown", label: "One period" },
  { key: "multiDropdown", label: "Multiple periods" },
]

// A date filter's "period type" — the app's existing dateMode, surfaced under the reference's
// wording. "Actual Period" picks named periods; the other two need no value list at all.
const VF_DATE_PERIODS: { key: "actual" | "relative" | "range"; label: string }[] = [
  { key: "actual", label: "Actual Period" },
  { key: "relative", label: "Relative Period" },
  { key: "range", label: "Range" },
]

function viewFilterComponents(type: FieldType): { key: ViewFilterComponent; label: string }[] {
  if (isNumericType(type)) return VF_NUMERIC_COMPONENTS
  if (type === "date") return VF_DATE_COMPONENTS
  return VF_CATEGORICAL_COMPONENTS
}

// The component actually in force: the builder's explicit pick, else the type's default.
function resolveViewFilterComponent(rule: FilterRule): ViewFilterComponent {
  const c = rule.vfComponent
  if (c === "singleList") return "singleDropdown"
  if (c === "multiList" || c === "multiCustomList") return "multiDropdown"
  if (c) return c
  return isNumericType(rule.type) ? "sliderDouble" : "multiDropdown"
}

// Categorical (text/person) "Wildcard" tab match types — one condition row per entry,
// all rows OR'd together.
type WildcardMatchType =
  | "Exactly Matches" | "Does Not Match"
  | "Contains" | "Does Not Contain"
  | "Starts With" | "Does Not Start With"
  | "Ends With" | "Does Not End With"

const WILDCARD_MATCH_TYPES: WildcardMatchType[] = [
  "Exactly Matches", "Does Not Match",
  "Contains", "Does Not Contain",
  "Starts With", "Does Not Start With",
  "Ends With", "Does Not End With",
]

// Categorical filter modal's Actual-tab match-mode dropdown labels — "any of"/"none of" are
// row-level, "all of"/"only" are group-level (see isSetMembershipFilterRule).
type CatMatchMode = "any" | "none" | "all" | "only" | "me" | "notMe"
const MATCH_MODE_LABEL: Record<CatMatchMode, string> = {
  any: "is any of", none: "is none of", all: "is all of", only: "is only",
  me: "is the current user", notMe: "is not the current user",
}
// Resolved when the report runs, not when it is built, so the saved rule is viewer-independent.
const isCurrentUserMode = (m: string | undefined) => m === "me" || m === "notMe"

const ACTUAL_DATE_VALUES: Record<string, string[]> = {
  "Year":           ["2021", "2022", "2023", "2024", "2025", "2026"],
  "Quarter & Year": ["Q1 2025", "Q2 2025", "Q3 2025", "Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"],
  "Quarter":        ["Q1", "Q2", "Q3", "Q4"],
  "Month & Year":   ["Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026"],
  "Month":          ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  "Week & Year":    Array.from({ length: 32 }, (_, i) => `W${i + 1} 2026`),
  "Week":           Array.from({ length: 52 }, (_, i) => `Week ${i + 1}`),
  "Date":           Array.from({ length: 35 }, (_, i) => {
    const d = new Date(2026, 5, 30); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10)
  }),
  "Date & Time":    Array.from({ length: 24 }, (_, i) => `2026-08-04 ${String(i).padStart(2, "0")}:00`),
}

// Filters offer four period levels. Quarter and Month always carry the year (Q1 2025, Jan 2026);
// the stored keys stay the bucket names the date logic already understands.
const FILTER_GRANULARITIES: { key: string; label: string }[] = [
  { key: "Year", label: "Year" },
  { key: "Quarter & Year", label: "Quarter" },
  { key: "Month & Year", label: "Month" },
  { key: "Date", label: "Date" },
]
const filterGranLabel = (key: string) => FILTER_GRANULARITIES.find((g) => g.key === key)?.label ?? key

const RELATIVE_OPTIONS: Record<string, string[]> = {
  "Year":           ["This year", "Year to date", "Last year", "Next year", "Last N years", "Next N years"],
  "Quarter & Year": ["This quarter", "Last quarter", "Next quarter", "Last N quarters", "Next N quarters"],
  "Quarter":        ["This quarter", "Last quarter", "Next quarter", "Last N quarters", "Next N quarters"],
  "Month & Year":   ["This month", "Last month", "Next month", "Last N months", "Next N months"],
  "Month":          ["This month", "Last month", "Next month", "Last N months", "Next N months"],
  "Week & Year":    ["This week", "Last week", "Next week", "Last N weeks", "Next N weeks"],
  "Week":           ["This week", "Last week", "Next week", "Last N weeks", "Next N weeks"],
  "Date":           ["Today", "Yesterday", "Tomorrow", "Last N days", "Next N days", "Day to date"],
  "Date & Time":    ["Now", "Today", "Yesterday", "Last N hours", "Next N hours"],
}

function isNInput(opt: string) { return /Last N|Next N/.test(opt) }

function filterOperators(type: FieldType): FilterOperator[] {
  if (isNumericType(type)) return ["is exactly...", "is not exactly...", "is greater than...", "is less than...", "is empty", "is not empty"]
  if (type === "date")   return ["is", "is not", "is before", "is after", "is between", "is empty", "is not empty"]
  if (type === "text")   return ["is exactly...", "is not...", "is one of...", "is none of...", "is empty", "is not empty"]
  if (type === "person") return ["is exactly...", "is not...", "is one of...", "is none of...", "is empty", "is not empty"]
  if (type === "boolean") return ["is exactly...", "is not...", "is empty", "is not empty"]
  return ["equals"]
}

function filterNeedsValue(operator: FilterOperator): boolean {
  return operator !== "is empty" && operator !== "is not empty"
}

function filterIsRange(operator: FilterOperator): boolean {
  return operator === "between" || operator === "is between"
}

// A freshly-dropped filter's defaults. Shared by both filter lists — the report's own base
// Filters and the View filters a viewer can tweak — so the two can never drift apart on what
// an unconfigured rule means.
function makeFilterRule(name: string, type: FieldType): FilterRule {
  const ops = filterOperators(type)
  return {
    field: name, type, operator: ops[0], value: "", value2: "", values: [],
    dateMode: "actual", dateGranularity: "Month & Year",
    dateRangeOp: "after", dateFrom: "", dateTo: "",
    dateRelativeOpt: "", dateRelativeN: 1, dateIncludeNull: false,
    catMode: "actual", catMatchMode: "any",
    wildcardConditions: [{ matchType: "Contains", value: "" }], wildcardIncludeEmpty: true,
    catTreatment: "categorical",
    numFunction: isNumericType(type) ? "Sum" : "Count",
    numMode: "actual", relativeDirection: "Top", relativeN: 5,
    vfDisplayName: "", vfComponent: "", vfListMode: "all", vfOfferedValues: [],
    ...(name === TIMELINE_KEY ? { tlExempt: [] } : {}),
  }
}

function DupFieldAlert({ name, count, onClose }: { name: string; count: number; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] overflow-hidden border-t-4 border-red-400">
        <div className="flex items-start gap-4 p-6 pb-4">
          <div className="shrink-0 w-10 h-10 rounded-full border-2 border-red-400 flex items-center justify-center text-red-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-bold text-gray-900 mb-1">Alert Message</p>
            <p className="text-[13px] text-gray-600 leading-relaxed">
              Please remove the field directly from the drop area you want to remove. "{name}" exists in {count} places.
            </p>
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-center">
          <button
            onClick={onClose}
            className="px-10 py-2 bg-indigo-600 text-white text-[13px] font-semibold rounded-lg
              hover:bg-indigo-700 transition-colors border-2 border-indigo-400"
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Shown when the user tries to drop a field into Filters before the report has any
// Columns/Rows/Values field yet — a filter with nothing to filter isn't meaningful.
// A tabular report lists one row per record, so a field can only earn one column. Dropping a
// field that is already on the other shelf is refused outright rather than silently ignored —
// the user needs to know where the existing copy lives so they can move it if that's the intent.
function FieldAlreadyUsedAlert({ name, zone, onClose }: { name: string; zone: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] overflow-hidden border-t-4 border-amber-400">
        <div className="flex items-start gap-4 p-6 pb-4">
          <div className="shrink-0 w-10 h-10 rounded-full border-2 border-amber-400 flex items-center justify-center text-amber-500">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-bold text-gray-900 mb-1">Field already in use</p>
            <p className="text-[13px] text-gray-600 leading-relaxed">
              &ldquo;{name}&rdquo; is already in <strong className="font-semibold text-gray-800">{zone}</strong>. A field
              can only be used once in a tabular report &mdash; drag it across if you want it there instead.
            </p>
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-center">
          <button
            onClick={onClose}
            className="px-10 py-2 bg-indigo-600 text-white text-[13px] font-semibold rounded-lg
              hover:bg-indigo-700 transition-colors border-2 border-indigo-400"
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function FilterNeedsFieldAlert({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] overflow-hidden border-t-4 border-red-400">
        <div className="flex items-start gap-4 p-6 pb-4">
          <div className="shrink-0 w-10 h-10 rounded-full border-2 border-red-400 flex items-center justify-center text-red-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-bold text-gray-900 mb-1">Alert Message</p>
            <p className="text-[13px] text-gray-600 leading-relaxed">
              Please drop at least one field into Columns, Rows, or Values before adding a filter.
            </p>
          </div>
        </div>
        <div className="px-6 pb-5 flex justify-center">
          <button
            onClick={onClose}
            className="px-10 py-2 bg-indigo-600 text-white text-[13px] font-semibold rounded-lg
              hover:bg-indigo-700 transition-colors border-2 border-indigo-400"
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Shown when switching Source — every dropped field's key encodes its owning module
// (makeFieldKey), so a Column/Row/Value/Filter built against the old source has no meaning
// against the new one. Rather than silently dropping them (surprising) or trying to carry
// them over (usually not even possible — most fields don't exist on both modules), this
// requires an explicit confirm before clearing.
function SourceChangeConfirmModal({ nextSource, onConfirm, onCancel }: {
  nextSource: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] overflow-hidden border-t-4 border-red-400">
        <div className="flex items-start gap-4 p-6 pb-4">
          <div className="shrink-0 w-10 h-10 rounded-full border-2 border-red-400 flex items-center justify-center text-red-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-bold text-gray-900 mb-1">Switch source to "{sourceLabel(nextSource)}"?</p>
            <p className="text-[13px] text-gray-600 leading-relaxed">
              Every field currently in Columns, Rows, Values, and Filters will be cleared. This can't be undone.
            </p>
          </div>
        </div>
        <div className="px-6 pb-5 flex items-center justify-center gap-3">
          <button
            onClick={onCancel}
            className="px-6 py-2 text-[13px] font-semibold text-gray-600 rounded-lg border border-gray-200
              hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-6 py-2 bg-red-500 text-white text-[13px] font-semibold rounded-lg
              hover:bg-red-600 transition-colors border-2 border-red-300"
          >
            Clear &amp; switch
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Dual-handle range slider — two overlapping native <input type="range"> elements (see
// .range-slider-thumb in index.css for the transparent-track trick that makes both
// independently draggable). Each onChange clamps against the other handle so lo never
// crosses hi.
function RangeSlider({ min, max, value, value2, onChange }: {
  min: number; max: number; value: number; value2: number
  onChange: (lo: number, hi: number) => void
}) {
  const span = Math.max(1e-9, max - min)
  const loPct = ((value - min) / span) * 100
  const hiPct = ((value2 - min) / span) * 100
  const step = span >= 100 ? Math.max(1, Math.round(span / 200)) : span / 200 || 1

  return (
    <div className="relative h-5 flex items-center">
      <div className="absolute left-0 right-0 h-1.5 bg-gray-200 rounded-full" />
      <div className="absolute h-1.5 bg-indigo-500 rounded-full" style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }} />
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Math.min(Number(e.target.value), value2), value2)}
        className="range-slider-thumb absolute inset-x-0"
      />
      <input
        type="range" min={min} max={max} step={step} value={value2}
        onChange={(e) => onChange(value, Math.max(Number(e.target.value), value))}
        className="range-slider-thumb absolute inset-x-0"
      />
    </div>
  )
}

// ── Inline calendar for the date filter's Range tab ──
const pad2 = (n: number) => String(n).padStart(2, "0")
const toISODay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const parseISODay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d) }
const fmtCalDate = (s: string) => {
  const d = parseISODay(s)
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`
}
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

/** One month grid (Monday first). After/Before pick one day; Between picks a start then an end,
    previewing the span on hover. One month at a time; arrows move between months. */
function RangeCalendar({ mode, from, to, onPick }: {
  mode: "after" | "before" | "between"
  from: string
  to: string
  onPick: (from: string, to: string) => void
}) {
  const anchor = from ? parseISODay(from) : TODAY
  const [view, setView] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1))
  const [hover, setHover] = useState("")
  const months = [view]
  const shift = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1))
  const today = toISODay(TODAY)

  // The span to shade: the picked range, or start → hovered day while choosing the end.
  const spanEnd = mode === "between" ? (to || (from && hover > from ? hover : "")) : ""
  const pick = (day: string) => {
    if (mode !== "between") return onPick(day, "")
    if (!from || to || day < from) return onPick(day, "")
    onPick(from, day)
  }

  return (
    <div className="flex gap-6 select-none" onMouseLeave={() => setHover("")}>
      {months.map((m, mi) => {
        const lead = (m.getDay() + 6) % 7
        const daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()
        const cells: (string | null)[] = [
          ...Array.from({ length: lead }, () => null),
          ...Array.from({ length: daysIn }, (_, i) => toISODay(new Date(m.getFullYear(), m.getMonth(), i + 1))),
        ]
        return (
          <div key={mi} className="w-full">
            <div className="flex items-center justify-between mb-2 h-7">
              {mi === 0
                ? <button onClick={() => shift(-1)} aria-label="Previous month" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><span className="rotate-180 inline-flex"><Ic.ChevRight size={12} /></span></button>
                : <span className="w-7" />}
              <span className="text-[13px] font-semibold text-gray-800">{MONTH_NAMES[m.getMonth()]} {m.getFullYear()}</span>
              {mi === months.length - 1
                ? <button onClick={() => shift(1)} aria-label="Next month" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><Ic.ChevRight size={12} /></button>
                : <span className="w-7" />}
            </div>
            <div className="grid grid-cols-7">
              {WEEKDAYS.map((w) => <span key={w} className="h-8 flex items-center justify-center text-[11px] font-medium text-gray-400">{w}</span>)}
              {cells.map((day, i) => {
                if (!day) return <span key={`b${i}`} className="h-9" />
                const isStart = day === from
                const isEnd = mode === "between" && day === spanEnd
                const inSpan = mode === "between" && !!from && !!spanEnd && day > from && day < spanEnd
                // After/Before: shade the side of the picked day that the filter keeps.
                const inSide = !!from && ((mode === "after" && day > from) || (mode === "before" && day < from))
                const picked = isStart || isEnd
                // The shaded band runs edge to edge; on a picked day it starts or stops at the
                // day's centre so the band joins the highlighted chip.
                const band = inSpan || inSide ? "bg-indigo-50"
                  : mode === "between" && isStart && spanEnd && spanEnd !== from ? "bg-gradient-to-r from-transparent from-50% to-indigo-50 to-50%"
                  : mode === "between" && isEnd && !isStart ? "bg-gradient-to-r from-indigo-50 from-50% to-transparent to-50%"
                  : mode === "after" && isStart ? "bg-gradient-to-r from-transparent from-50% to-indigo-50 to-50%"
                  : mode === "before" && isStart ? "bg-gradient-to-r from-indigo-50 from-50% to-transparent to-50%"
                  : ""
                return (
                  <button
                    key={day}
                    onClick={() => pick(day)}
                    onMouseEnter={() => setHover(day)}
                    className={`group h-9 flex items-center justify-center ${band}`}
                  >
                    <span className={`w-9 h-9 flex items-center justify-center rounded-lg text-[13px] transition-colors
                      ${picked ? "bg-indigo-600 text-white font-semibold"
                        : inSpan || inSide ? "text-indigo-700 group-hover:bg-indigo-100"
                        : "text-gray-700 group-hover:bg-gray-100"}
                      ${!picked && day === today ? "ring-1 ring-inset ring-indigo-300" : ""}`}
                    >
                      {Number(day.slice(8))}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DateFilterModal({ rule, onChange, onClose, strip, timelineMetricKeys }: {
  rule: FilterRule
  onChange: (patch: Partial<FilterRule>) => void
  onClose: () => void
  /** Rendered under the header — the Timeline's "Applies to". */
  strip?: React.ReactNode
  /** Timeline only: the metrics it governs. Actual Data then lists the periods their own dates
      fall in, instead of a field's values. */
  timelineMetricKeys?: string[]
}) {
  // Every record behind a time-tracked metric has a date, so the Timeline has no nulls to include.
  const showNull = rule.field !== TIMELINE_KEY
  const mode = rule.dateMode ?? "actual"
  const gran = rule.dateGranularity || "Month & Year"
  const rangeOp = rule.dateRangeOp ?? "after"
  const selectedValues: string[] = rule.values ?? []
  const [search, setSearch] = useState("")

  const granList = FILTER_GRANULARITIES.map((g) => g.key)
  const metricKeysSig = timelineMetricKeys?.join("|")
  const allActual = useMemo(
    () => timelineMetricKeys ? timelineActualValues(timelineMetricKeys, gran) : (ACTUAL_DATE_VALUES[gran] ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gran, metricKeysSig],
  )
  const actualOptions = allActual.filter(v =>
    v.toLowerCase().includes(search.toLowerCase())
  )
  const relativeOpts = RELATIVE_OPTIONS[gran] ?? []

  const inputCls = "border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 w-full"

  const toggleValue = (v: string) => {
    const next = selectedValues.includes(v)
      ? selectedValues.filter(x => x !== v)
      : [...selectedValues, v]
    onChange({ values: next })
  }

  // Chip summary helper used externally too — keeps modal self-contained
  const tabButton = (label: string, key: "actual" | "range" | "relative") => (
    <button
      key={key}
      onClick={() => onChange({ dateMode: key })}
      className={`px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors
        ${mode === key ? "bg-indigo-600 text-white shadow-sm" : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  )

  const GranSelect = ({ activeKey, onSelect }: { activeKey: string; onSelect: (g: string) => void }) => (
    <div className="relative shrink-0">
      <select
        value={activeKey}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Date grain"
        className="appearance-none border border-gray-200 rounded-lg pl-3 pr-8 py-1.5 text-[13px] font-medium text-gray-700 bg-white cursor-pointer focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
      >
        {granList.map((g) => <option key={g} value={g}>{filterGranLabel(g)}</option>)}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400"><Ic.ChevDown /></span>
    </div>
  )

  const NullToggle = () => !showNull ? null : (
    <label className="flex items-center gap-2 cursor-pointer select-none mt-3">
      <span
        onClick={() => onChange({ dateIncludeNull: !rule.dateIncludeNull })}
        className={`flex items-center justify-center w-4 h-4 rounded border transition-colors shrink-0
          ${rule.dateIncludeNull ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}
      >
        {rule.dateIncludeNull && (
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </span>
      <span className="text-[12px] text-gray-500">Include null values</span>
    </label>
  )

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

      {/* Modal card */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-[600px] flex flex-col overflow-hidden" style={{ height: 520 }}>
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100">
          {fieldTypeIcon("date", 15)}
          <span className="text-[15px] font-semibold text-gray-900">{fieldDisplayName(rule.field)}</span>
          <div className="flex items-center gap-1 ml-4">
            {tabButton("Actual Data", "actual")}
            {tabButton("Range", "range")}
            {tabButton("Relative", "relative")}
          </div>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-lg hover:bg-gray-100">
            <Ic.X size={14} />
          </button>
        </div>

        {strip}

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Actual Data ── */}
          {mode === "actual" && (
            <>
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Grain + search */}
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100">
                  <GranSelect activeKey={gran} onSelect={(g) => onChange({ dateGranularity: g, values: [] })} />
                  <div className="flex-1 flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
                    <Ic.Search />
                    <input
                      autoFocus
                      type="text"
                      placeholder="Search…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      className="flex-1 bg-transparent text-[13px] text-gray-700 placeholder-gray-400 focus:outline-none"
                    />
                    {search && <button onClick={() => setSearch("")} className="text-gray-300 hover:text-gray-500"><Ic.X size={11} /></button>}
                  </div>
                </div>
                {/* Select all/none */}
                <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-100 bg-gray-50">
                  <span className="text-[11px] text-gray-400">{selectedValues.length} of {allActual.length} selected</span>
                  <div className="flex gap-2">
                    <button onClick={() => onChange({ values: allActual })} className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium">All</button>
                    <button onClick={() => onChange({ values: [] })} className="text-[11px] text-gray-400 hover:text-gray-600">None</button>
                  </div>
                </div>
                {/* Options */}
                <div className="overflow-y-auto flex-1">
                  {actualOptions.length === 0
                    ? <p className="text-[13px] text-gray-400 text-center py-8">No matches</p>
                    : <div className="grid grid-cols-3 gap-1 p-2 content-start">{actualOptions.map(v => {
                        const checked = selectedValues.includes(v)
                        return (
                          <button key={v} onClick={() => toggleValue(v)} title={v}
                            className={`flex items-center gap-2.5 w-full min-w-0 px-2.5 py-2 rounded-md text-[13px] text-left transition-colors
                              ${checked ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-50"}`}
                          >
                            <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                              ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}>
                              {checked && <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                            </span>
                            <span className="truncate">{v}</span>
                          </button>
                        )
                      })}</div>
                  }
                </div>
                {showNull && <div className="px-4 pb-3 pt-1 border-t border-gray-100"><NullToggle /></div>}
              </div>
            </>
          )}

          {/* ── Range ── */}
          {mode === "range" && (
            <div className="flex-1 px-5 py-4 flex flex-col gap-3 overflow-y-auto">
              <div className="flex items-center gap-3">
                <div className="relative w-40 shrink-0">
                  <select
                    value={rangeOp}
                    onChange={(e) => onChange({ dateRangeOp: e.target.value as "after" | "before" | "between", dateFrom: "", dateTo: "" })}
                    aria-label="Filter type"
                    className="appearance-none w-full border border-gray-200 rounded-lg pl-3 pr-8 py-1.5 text-[13px] font-medium text-gray-700 bg-white cursor-pointer focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                  >
                    <option value="after">After</option>
                    <option value="before">Before</option>
                    <option value="between">Between</option>
                  </select>
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400"><Ic.ChevDown /></span>
                </div>
                <span className="text-[13px] text-gray-500 truncate">
                  {rangeOp === "between"
                    ? (rule.dateFrom
                        ? <><span className="text-gray-800 font-medium">{fmtCalDate(rule.dateFrom)}</span> – {rule.dateTo ? <span className="text-gray-800 font-medium">{fmtCalDate(rule.dateTo)}</span> : "pick an end date"}</>
                        : "Pick a start date")
                    : (rule.dateFrom ? <span className="text-gray-800 font-medium">{fmtCalDate(rule.dateFrom)}</span> : "Pick a date")}
                </span>
              </div>

              <RangeCalendar
                mode={rangeOp}
                from={rule.dateFrom ?? ""}
                to={rule.dateTo ?? ""}
                onPick={(from, to) => onChange({ dateFrom: from, dateTo: to })}
              />

              <NullToggle />
            </div>
          )}

          {/* ── Relative ── */}
          {mode === "relative" && (
            <>
              <div className="flex-1 flex flex-col overflow-y-auto p-4 gap-1">
                <div className="mb-2"><GranSelect activeKey={gran} onSelect={(g) => onChange({ dateGranularity: g, dateRelativeOpt: "", dateRelativeN: 1 })} /></div>
                {relativeOpts.map(opt => {
                  const active = rule.dateRelativeOpt === opt
                  const needsN = isNInput(opt)
                  return (
                    <label key={opt} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors
                      ${active ? "bg-indigo-50" : "hover:bg-gray-50"}`}
                    >
                      {/* Radio */}
                      <span
                        onClick={() => onChange({ dateRelativeOpt: opt, dateRelativeN: rule.dateRelativeN || 1 })}
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors
                          ${active ? "border-indigo-600" : "border-gray-300"}`}
                      >
                        {active && <span className="w-2 h-2 rounded-full bg-indigo-600" />}
                      </span>
                      <span
                        onClick={() => onChange({ dateRelativeOpt: opt, dateRelativeN: rule.dateRelativeN || 1 })}
                        className={`text-[13px] flex-1 ${active ? "text-indigo-700 font-medium" : "text-gray-700"}`}
                      >
                        {needsN
                          ? opt.replace("N ", "")  // show "Last  days" with input in between
                          : opt}
                      </span>
                      {needsN && active && (
                        <input
                          type="number" min={1}
                          value={rule.dateRelativeN ?? 1}
                          onChange={e => onChange({ dateRelativeN: Math.max(1, Number(e.target.value)) })}
                          onClick={e => e.stopPropagation()}
                          className="w-16 border border-indigo-300 rounded-lg px-2 py-1 text-[13px] text-center text-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                      )}
                    </label>
                  )
                })}
                {showNull && <div className="mt-2 pt-2 border-t border-gray-100"><NullToggle /></div>}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-t border-gray-100 bg-gray-50">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-[13px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => onChange({ values: [], dateFrom: "", dateTo: "", dateRelativeOpt: "", dateRelativeN: 1, dateIncludeNull: false })}
            className="px-4 py-2 text-[13px] text-gray-500 hover:text-gray-700 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Categorical (text/person) filter modal — "Actual" (real values, checkbox multi-select,
// with an Exclude-selected toggle) and "Wildcard" (OR'd pattern-matching conditions).
// Mirrors DateFilterModal's structure (portalled backdrop + centered card, tab pills in
// the header, Apply/Clear footer) so the two "big modal" filter experiences feel like one
// consistent system rather than two unrelated ones.
const ONLY_ME_TIP = "Untick “Only me” to pick people"

// A tooltip that tracks the pointer. Portalled to the body because the filter card clips its
// overflow, and kept on screen by measuring itself: the view-filter rail sits at the right edge,
// so a tooltip anchored at the cursor would usually run off it.
function CursorTooltip({ text, at }: { text: string; at: { x: number; y: number } }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    if (ref.current) setSize({ w: ref.current.offsetWidth, h: ref.current.offsetHeight })
  }, [text])
  const gap = 14
  const left = Math.max(8, Math.min(at.x - size.w / 2, window.innerWidth - size.w - 8))
  // Below the pointer, so it never sits under it; above if that would leave the viewport.
  const below = at.y + gap + size.h <= window.innerHeight - 8
  const top = below ? at.y + gap : at.y - gap - size.h
  return createPortal(
    <span
      ref={ref}
      role="tooltip"
      style={{ position: "fixed", left, top, visibility: size.w ? "visible" : "hidden" }}
      className="pointer-events-none z-[300] whitespace-nowrap rounded-md bg-gray-900 px-2 py-1
        text-[11px] leading-snug text-white shadow-lg"
    >
      {text}
    </span>,
    document.body,
  )
}

// Which relationship a FILTER reads its field through — the filter-side twin of the role pill on
// a chip. Only rendered where the field can be reached more than one way.
function FilterRoleStrip({ grainModule, source, rule, onChange, compact, readOnly }: {
  grainModule: string
  /** The report's source: a Team member filter offers the roles of this module. */
  source?: string
  rule: FilterRule
  onChange: (patch: Partial<FilterRule>) => void
  /** Tighter padding for the view-filter rail. */
  compact?: boolean
  /** Viewers see which relationship applies but cannot change it — it is part of the report's
      definition, like the field itself. */
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const options = availableLookupPaths(grainModule, rule.field, source)
  if (options.length < 2) return null
  const chosen = normalizeRoleId(rule.lookupPath)
  const current = chosen && options.includes(chosen) ? chosen : defaultLookupPath(options)!
  const currentRole = PERSON_ROLES[current]
  const isMulti = !!currentRole?.idsKey
  const pad = compact ? "px-2.5 py-1 text-[11px]" : "px-5 py-2 text-[12px]"
  if (readOnly) {
    return (
      <div className={`flex items-center gap-1.5 border-b border-gray-100 bg-sky-50/50 text-gray-500 ${pad}`}>
        via <span className="font-medium text-sky-700">{roleDisplayName(current)}</span>
      </div>
    )
  }
  return (
    <div className={`flex items-center gap-2 border-b border-gray-100 bg-sky-50/50 text-gray-600 ${pad}`}>
      <span className="shrink-0">{compact ? "via" : "Matched through"}</span>
      <button
        ref={btnRef}
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 font-medium text-sky-700 bg-white border border-sky-200 rounded px-2 py-0.5
          hover:bg-sky-50 transition-colors shrink-0"
      >
        {roleDisplayName(current)}<Ic.ChevDown size={9} />
      </button>
      {/* A one-to-many role tests every person on the record, which is easy to get backwards. */}
      {isMulti && !compact && (
        <span className="text-gray-400 truncate">
          a {grainModule.toLowerCase()} matches if any of the {roleDisplayName(current).toLowerCase()} does
        </span>
      )}
      {open && (
        <ChipPortalMenu anchorRef={btnRef} onClose={() => setOpen(false)}>
          <RoleMenuList
            title="Match this filter via"
            options={options}
            current={current}
            onPick={(opt) => { onChange({ lookupPath: opt }); setOpen(false) }}
          />
        </ChipPortalMenu>
      )}
    </div>
  )
}

function CategoricalFilterModal({ rule, allRules, source, fields, aggregations, rangeConfigs, valueOptions, flat, onChange, onClose }: {
  rule: FilterRule
  allRules: FilterRule[]
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  // Optional override for the Actual-tab value list — View filters pass the base-filtered
  // subset so a viewer is never offered a value the report's own scope already excluded.
  valueOptions?: string[] | null
  // Flat (tabular) mode: one value per record, so the Count / Distinct-Count treatments and the
  // "all of" / "only" set operators have no meaning — they'd degenerate silently. Hidden, not
  // reinterpreted.
  flat?: boolean
  onChange: (patch: Partial<FilterRule>) => void
  onClose: () => void
}) {
  const treatment = rule.catTreatment ?? "categorical"
  const mode = rule.catMode ?? "actual"
  const selectedValues: string[] = rule.values ?? []
  const conditions = rule.wildcardConditions && rule.wildcardConditions.length > 0
    ? rule.wildcardConditions
    : [{ matchType: "Contains" as WildcardMatchType, value: "" }]

  // Actual-tab set operator — "any"/"none" are row-level (unchanged/renamed-from-excludeSelected
  // behavior); "all"/"only" are group-level, see applyGroupLevelFilters. Shown on every
  // categorical field uniformly (no hiding based on whether a real one-to-many relationship
  // exists) — the live match-count hint below keeps a degenerate same-grain field honest
  // instead of a silently-empty or mysteriously-disabled control.
  const matchMode = rule.catMatchMode ?? "any"
  const [showMatchModeMenu, setShowMatchModeMenu] = useState(false)
  const matchModeBtnRef = useRef<HTMLButtonElement>(null)
  const matchCount = treatment === "categorical" && mode === "actual" && (matchMode === "all" || matchMode === "only")
    ? previewSetMembershipOverlap(source, fields, aggregations, allRules, rule.field, selectedValues, matchMode === "only", rangeConfigs)
    : null

  // "Count"/"Distinct Count" treatment filters the REPORT'S OWN pivot rows by a group-level
  // aggregate of this field, not by the field's own value — reuses the same Actual/Range/
  // Relative shape as NumericFilterModal, sourced from a live preview of the current grouping.
  const groupMode: "count" | "distinctCount" = treatment === "distinctCount" ? "distinctCount" : "count"
  const groupAggValues = treatment !== "categorical"
    ? previewGroupAggregates(source, fields, aggregations, allRules, rule.field, groupMode, rangeConfigs)
    : []
  const distinctAggValues = [...new Set(groupAggValues)].sort((a, b) => a - b)
  const aggMin = distinctAggValues.length ? distinctAggValues[0] : 0
  const aggMax = distinctAggValues.length ? distinctAggValues[distinctAggValues.length - 1] : 0
  const numMode = rule.numMode ?? "actual"
  const rangeLo = rule.value !== "" && rule.value != null ? Number(rule.value) : aggMin
  const rangeHi = rule.value2 !== "" && rule.value2 != null ? Number(rule.value2) : aggMax
  const relativeDirection = rule.relativeDirection ?? "Top"
  const [search, setSearch] = useState("")

  const allValues = (valueOptions !== undefined ? valueOptions : fieldValues(rule.field, rule.type)) ?? []
  const filteredOptions = allValues.filter((v) => v.toLowerCase().includes(search.toLowerCase()))

  const toggleValue = (v: string) => {
    const next = selectedValues.includes(v)
      ? selectedValues.filter((x) => x !== v)
      : [...selectedValues, v]
    onChange({ values: next })
  }

  const updateCondition = (index: number, patch: Partial<{ matchType: WildcardMatchType; value: string }>) => {
    const next = conditions.map((c, i) => (i === index ? { ...c, ...patch } : c))
    onChange({ wildcardConditions: next })
  }
  const addCondition = () => onChange({ wildcardConditions: [...conditions, { matchType: "Contains" as WildcardMatchType, value: "" }] })
  const removeCondition = (index: number) => onChange({ wildcardConditions: conditions.filter((_, i) => i !== index) })

  // Sub-mode tabs (Actual/Wildcard or Actual/Range/Relative) — secondary, subdued segmented
  // control. The "Treat field as" choice above them is the primary decision (it changes what
  // kind of filter this even is), so it gets the prominent pill treatment instead.
  const tabButton = (label: string, key: "actual" | "wildcard") => (
    <button
      key={key}
      onClick={() => onChange({ catMode: key })}
      className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors
        ${mode === key ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
    >
      {label}
    </button>
  )

  const numTabButton = (label: string, key: "actual" | "range" | "relative") => (
    <button
      key={key}
      onClick={() => onChange({ numMode: key })}
      className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors
        ${numMode === key ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
    >
      {label}
    </button>
  )

  const treatmentButton = (label: string, key: "categorical" | "count" | "distinctCount") => (
    <button
      key={key}
      onClick={() => onChange({ catTreatment: key })}
      className={`px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors
        ${treatment === key ? "bg-indigo-600 text-white shadow-sm" : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"}`}
    >
      {label}
    </button>
  )

  // Shared small checkbox-toggle row, reused for "Exclude Selected Values" and
  // "Include all values when empty" — same visual as DateFilterModal's NullToggle.
  const ToggleRow = ({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) => (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span
        onClick={onToggle}
        className={`flex items-center justify-center w-4 h-4 rounded border transition-colors shrink-0
          ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </span>
      <span className="text-[12px] text-gray-500">{label}</span>
    </label>
  )

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

      {/* Modal card */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-[520px] flex flex-col overflow-hidden" style={{ height: 480 }}>
        {/* Header — "Treat field as" is the primary decision (it changes what kind of
            filter this even is), so it gets top billing and the prominent pill treatment. */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100">
          {fieldTypeIcon(rule.type, 15)}
          <span className="text-[15px] font-semibold text-gray-900">{fieldDisplayName(rule.field)}</span>
          {!flat && (
            <div className="flex items-center gap-1 ml-4">
              {treatmentButton("Categorical", "categorical")}
              {treatmentButton("Count", "count")}
              {treatmentButton("Distinct Count", "distinctCount")}
            </div>
          )}
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-lg hover:bg-gray-100">
            <Ic.X size={14} />
          </button>
        </div>

        <FilterRoleStrip grainModule={pickGrain(source, fields, allRules)} source={source} rule={rule} onChange={onChange} />

        {/* Sub-mode — secondary, subdued segmented control */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 bg-gray-50/60">
          <div className="flex items-center rounded-md border border-gray-200 p-0.5 bg-white flex-1">
            {treatment === "categorical" ? (
              <>
                {tabButton("Actual", "actual")}
                {tabButton("Wildcard", "wildcard")}
              </>
            ) : (
              <>
                {numTabButton("Actual", "actual")}
                {numTabButton("Range", "range")}
                {numTabButton("Relative", "relative")}
              </>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* ── Actual (categorical) ── */}
          {treatment === "categorical" && mode === "actual" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Search */}
              <div className="px-3 py-2.5 border-b border-gray-100">
                <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
                  <Ic.Search />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search values…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-[13px] text-gray-700 placeholder-gray-400 focus:outline-none"
                  />
                  {search && <button onClick={() => setSearch("")} className="text-gray-300 hover:text-gray-500"><Ic.X size={11} /></button>}
                </div>
              </div>
              {/* Match mode + select all/none */}
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-100 bg-gray-50 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    ref={matchModeBtnRef}
                    onClick={() => setShowMatchModeMenu((p) => !p)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 transition-colors shrink-0"
                  >
                    {MATCH_MODE_LABEL[matchMode]}
                    <Ic.ChevDown size={9} />
                  </button>
                  {showMatchModeMenu && (
                    <ChipPortalMenu anchorRef={matchModeBtnRef} onClose={() => setShowMatchModeMenu(false)}>
                      <div className="bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-52 mt-1">
                        {(((flat ? ["any", "none"] : ["any", "none", "all", "only"])
                          .concat(rule.type === "person" ? ["me", "notMe"] : [])) as CatMatchMode[]).map((key) => (
                          <button
                            key={key}
                            onClick={() => { onChange({ catMatchMode: key }); setShowMatchModeMenu(false) }}
                            className={`flex items-center justify-between w-full px-3 py-1.5 text-[13px] hover:bg-indigo-50 transition-colors
                              ${matchMode === key ? "text-indigo-600 font-medium" : "text-gray-700"}`}
                          >
                            {MATCH_MODE_LABEL[key]}
                            {matchMode === key && <Ic.Check />}
                          </button>
                        ))}
                      </div>
                    </ChipPortalMenu>
                  )}
                  {!isCurrentUserMode(matchMode) && (
                    <span className="text-[11px] text-gray-400 truncate">{selectedValues.length} of {allValues.length} selected</span>
                  )}
                </div>
                {!isCurrentUserMode(matchMode) && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => onChange({ values: allValues })} className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium">All</button>
                    <button onClick={() => onChange({ values: [] })} className="text-[11px] text-gray-400 hover:text-gray-600">None</button>
                  </div>
                )}
              </div>
              {/* Options */}
              <div className="overflow-y-auto flex-1">
                {isCurrentUserMode(matchMode) ? (
                  <p className="px-4 py-6 text-center text-[13px] text-gray-700">
                    {matchMode === "me" ? "Matches the person viewing the report." : "Excludes the person viewing the report."}
                  </p>
                ) : filteredOptions.length === 0
                  ? <p className="text-[13px] text-gray-400 text-center py-8">No matches</p>
                  : filteredOptions.map(v => {
                      const checked = selectedValues.includes(v)
                      return (
                        <button key={v} onClick={() => toggleValue(v)}
                          className={`flex items-center gap-3 w-full px-4 py-2 text-[13px] text-left transition-colors
                            ${checked ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-50"}`}
                        >
                          <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                            ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}>
                            {checked && <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </span>
                          {v}
                        </button>
                      )
                    })
                }
              </div>
              {matchCount && (
                <div className="px-4 pb-3 pt-2 border-t border-gray-100">
                  <p className={`text-[12px] ${matchCount.matching === 0 && selectedValues.length > 0 ? "text-amber-600" : "text-gray-400"}`}>
                    {selectedValues.length === 0
                      ? "Select at least one value to match on."
                      : matchCount.matching > 0
                        ? `${matchCount.matching} of ${matchCount.total} current ${matchCount.total === 1 ? "group" : "groups"} match ${matchMode === "only" ? "exactly " : ""}all ${selectedValues.length} selected value${selectedValues.length === 1 ? "" : "s"}.`
                        : `0 of ${matchCount.total} current ${matchCount.total === 1 ? "group" : "groups"} match — best match has ${matchCount.bestOverlap} of ${selectedValues.length} selected value${selectedValues.length === 1 ? "" : "s"}.`}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Wildcard ── */}
          {treatment === "categorical" && mode === "wildcard" && (
            <div className="flex-1 p-5 flex flex-col gap-3 overflow-y-auto">
              {conditions.map((cond, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <select
                      value={cond.matchType}
                      onChange={(e) => updateCondition(i, { matchType: e.target.value as WildcardMatchType })}
                      className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 bg-white shrink-0"
                    >
                      {WILDCARD_MATCH_TYPES.map((mt) => <option key={mt} value={mt}>{mt}</option>)}
                    </select>
                    <input
                      type="text"
                      placeholder="Enter the value"
                      value={cond.value}
                      onChange={(e) => updateCondition(i, { value: e.target.value })}
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                    {conditions.length > 1 && (
                      <button onClick={() => removeCondition(i)} className="text-gray-300 hover:text-gray-600 transition-colors p-1 shrink-0">
                        <Ic.X size={12} />
                      </button>
                    )}
                  </div>
                  {i < conditions.length - 1 && (
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider text-center">OR</p>
                  )}
                </div>
              ))}
              <button onClick={addCondition} className="text-[12px] text-indigo-500 hover:text-indigo-700 font-medium text-left">
                + Add condition
              </button>
              <div className="mt-auto pt-2 border-t border-gray-100">
                <ToggleRow
                  checked={rule.wildcardIncludeEmpty !== false}
                  onToggle={() => onChange({ wildcardIncludeEmpty: !(rule.wildcardIncludeEmpty !== false) })}
                  label="Include all values when empty"
                />
              </div>
            </div>
          )}

          {/* ── Actual (Count / Distinct Count) — checkbox list of the aggregate values the
              current report's own row groups actually produce right now ── */}
          {treatment !== "categorical" && numMode === "actual" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-100 bg-gray-50">
                <span className="text-[11px] text-gray-400">{selectedValues.length} of {distinctAggValues.length} selected</span>
                <div className="flex gap-2">
                  <button onClick={() => onChange({ values: distinctAggValues.map(String) })} className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium">All</button>
                  <button onClick={() => onChange({ values: [] })} className="text-[11px] text-gray-400 hover:text-gray-600">None</button>
                </div>
              </div>
              <div className="overflow-y-auto flex-1">
                {distinctAggValues.length === 0
                  ? <p className="text-[13px] text-gray-400 text-center py-8">No groups yet — add a Row or Column field first</p>
                  : distinctAggValues.map((v) => {
                      const checked = selectedValues.includes(String(v))
                      return (
                        <button key={v} onClick={() => toggleValue(String(v))}
                          className={`flex items-center gap-3 w-full px-4 py-2 text-[13px] text-left tabular-nums transition-colors
                            ${checked ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-50"}`}
                        >
                          <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                            ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}>
                            {checked && <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </span>
                          {v}
                        </button>
                      )
                    })
                }
              </div>
            </div>
          )}

          {/* ── Range (Count / Distinct Count) ── */}
          {treatment !== "categorical" && numMode === "range" && (
            <div className="p-6 flex flex-col gap-6 flex-1">
              <div className="flex items-center justify-between text-[13px] text-gray-500 tabular-nums">
                <span>Min: {aggMin}</span>
                <span>Max: {aggMax}</span>
              </div>
              <RangeSlider
                min={aggMin} max={aggMax} value={rangeLo} value2={rangeHi}
                onChange={(newLo, newHi) => onChange({ value: String(newLo), value2: String(newHi) })}
              />
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">From</label>
                  <input type="number" value={rangeLo}
                    onChange={(e) => onChange({ value: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
                </div>
                <span className="text-gray-300 mt-4">→</span>
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">To</label>
                  <input type="number" value={rangeHi}
                    onChange={(e) => onChange({ value2: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
                </div>
              </div>
            </div>
          )}

          {/* ── Relative (Count / Distinct Count) ── */}
          {treatment !== "categorical" && numMode === "relative" && (
            <div className="p-6 flex flex-col gap-4 flex-1">
              <div className="flex items-center rounded-md border border-gray-200 p-0.5 w-fit">
                {(["Top", "Bottom"] as const).map((d) => (
                  <button key={d} onClick={() => onChange({ relativeDirection: d })}
                    className={`px-6 py-1.5 rounded text-[13px] font-medium transition-colors
                      ${relativeDirection === d ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">Number of groups</label>
                <input type="number" min={1} value={rule.relativeN ?? 5}
                  onChange={(e) => onChange({ relativeN: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
              </div>
              <p className="text-[12px] text-gray-400">
                Keeps the {relativeDirection === "Top" ? "highest" : "lowest"} {rule.relativeN ?? 5} pivot rows by {groupMode === "distinctCount" ? "Distinct Count" : "Count"} of {fieldDisplayName(rule.field)}.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-t border-gray-100 bg-gray-50">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-[13px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => onChange({
              values: [], catMatchMode: "any",
              wildcardConditions: [{ matchType: "Contains", value: "" }], wildcardIncludeEmpty: true,
              value: "", value2: "", relativeDirection: "Top", relativeN: 5,
            })}
            className="px-4 py-2 text-[13px] text-gray-500 hover:text-gray-700 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Numeric filter modal. "Function" (header, primary) picks which of the Values bucket's 6
// aggregate functions (AGG_OPTIONS) this filter is built on — a numeric field in Filters is
// always group-level, filtering the REPORT'S OWN pivot rows by that function's aggregate of
// the field (see applyGroupLevelFilters), never the field's own raw per-row value. "Actual" /
// "Range" / "Relative" (secondary, subdued) then work the same way CategoricalFilterModal's
// Count/Distinct-Count tabs do, sourced from a live preview of the current grouping.
function NumericFilterModal({ rule, allRules, source, fields, aggregations, rangeConfigs, flat, onChange, onClose }: {
  rule: FilterRule
  allRules: FilterRule[]
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  // Flat (tabular) mode: the filter compares the record's own value, so there is no aggregate
  // function to choose and the value list comes from the records themselves.
  flat?: boolean
  onChange: (patch: Partial<FilterRule>) => void
  onClose: () => void
}) {
  const fn = rule.numFunction || "Sum"
  const mode = rule.numMode ?? "actual"
  const selectedValues: string[] = rule.values ?? []
  const [search, setSearch] = useState("")
  const [showFnMenu, setShowFnMenu] = useState(false)
  const fnBtnRef = useRef<HTMLButtonElement>(null)

  // The bounds this filter offers must be what's reachable BEFORE it applies — scoping them by
  // the rule's own current setting would let the slider walk itself inward on every drag.
  const groupAggValues = flat
    ? flatFieldNumericValues(source, fields, allRules, allRules.filter((r) => r.field !== rule.field), rule.field)
    : previewGroupAggregates(source, fields, aggregations, allRules, rule.field, fn, rangeConfigs)
  const distinctAggValues = [...new Set(groupAggValues)].sort((a, b) => a - b)
  const aggMin = distinctAggValues.length ? distinctAggValues[0] : 0
  const aggMax = distinctAggValues.length ? distinctAggValues[distinctAggValues.length - 1] : 0
  const filteredOptions = distinctAggValues.filter((v) => String(v).includes(search))

  const toggleValue = (v: number) => {
    const s = String(v)
    const next = selectedValues.includes(s) ? selectedValues.filter((x) => x !== s) : [...selectedValues, s]
    onChange({ values: next })
  }

  const lo = rule.value !== "" && rule.value != null ? Number(rule.value) : aggMin
  const hi = rule.value2 !== "" && rule.value2 != null ? Number(rule.value2) : aggMax
  const direction = rule.relativeDirection ?? "Top"

  const tabButton = (label: string, key: "actual" | "range" | "relative") => (
    <button
      key={key}
      onClick={() => onChange({ numMode: key })}
      className={`flex-1 py-1.5 rounded text-[12px] font-medium transition-colors
        ${mode === key ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
    >
      {label}
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-2xl w-[520px] flex flex-col overflow-hidden" style={{ height: 480 }}>
        {/* Header — field identity + Function, the primary decision. Everything below
            filters on THIS aggregate of the field (computed across the report's own pivot
            rows), not its raw value. */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100">
          {fieldTypeIcon(rule.type, 15)}
          <span className="text-[15px] font-semibold text-gray-900">{fieldDisplayName(rule.field)}</span>
          {flat ? (
            <span className="ml-4 text-[11px] text-gray-400">record value</span>
          ) : (
            <button
              ref={fnBtnRef}
              onClick={() => setShowFnMenu((p) => !p)}
              className="flex items-center gap-1 ml-4 px-3 py-1.5 rounded-full text-[13px] font-medium bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 transition-colors"
            >
              {fn}
              <Ic.ChevDown size={11} />
            </button>
          )}
          {!flat && showFnMenu && (
            <ChipPortalMenu anchorRef={fnBtnRef} onClose={() => setShowFnMenu(false)}>
              <div className="bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-40 mt-1">
                {AGG_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => { onChange({ numFunction: opt }); setShowFnMenu(false) }}
                    className={`flex items-center justify-between w-full px-3 py-1.5 text-[13px] hover:bg-indigo-50 transition-colors
                      ${fn === opt ? "text-indigo-600 font-medium" : "text-gray-700"}`}
                  >
                    {opt}
                    {fn === opt && <Ic.Check />}
                  </button>
                ))}
              </div>
            </ChipPortalMenu>
          )}
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-lg hover:bg-gray-100">
            <Ic.X size={14} />
          </button>
        </div>

        <FilterRoleStrip grainModule={pickGrain(source, fields, allRules)} source={source} rule={rule} onChange={onChange} />

        {/* Sub-mode — secondary, subdued segmented control */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 bg-gray-50/60">
          <div className="flex items-center rounded-md border border-gray-200 p-0.5 bg-white flex-1">
            {tabButton("Actual", "actual")}
            {tabButton("Range", "range")}
            {tabButton("Relative", "relative")}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {mode === "actual" && (
            <div className="flex flex-col h-full">
              <div className="px-3 py-2.5 border-b border-gray-100">
                <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
                  <Ic.Search />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search values…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-[13px] text-gray-700 placeholder-gray-400 focus:outline-none"
                  />
                  {search && <button onClick={() => setSearch("")} className="text-gray-300 hover:text-gray-500"><Ic.X size={11} /></button>}
                </div>
              </div>
              <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-100 bg-gray-50">
                <span className="text-[11px] text-gray-400">{selectedValues.length} of {distinctAggValues.length} selected</span>
                <div className="flex gap-2">
                  <button onClick={() => onChange({ values: distinctAggValues.map(String) })} className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium">All</button>
                  <button onClick={() => onChange({ values: [] })} className="text-[11px] text-gray-400 hover:text-gray-600">None</button>
                </div>
              </div>
              <div className="overflow-y-auto flex-1">
                {filteredOptions.length === 0
                  ? <p className="text-[13px] text-gray-400 text-center py-8">No groups yet — add a Row or Column field first</p>
                  : filteredOptions.map((v) => {
                      const checked = selectedValues.includes(String(v))
                      return (
                        <button key={v} onClick={() => toggleValue(v)}
                          className={`flex items-center gap-3 w-full px-4 py-2 text-[13px] text-left tabular-nums transition-colors
                            ${checked ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-50"}`}
                        >
                          <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                            ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}>
                            {checked && <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </span>
                          {fmtNum(v)}
                        </button>
                      )
                    })
                }
              </div>
            </div>
          )}

          {mode === "range" && (
            <div className="p-6 flex flex-col gap-6">
              <div className="flex items-center justify-between text-[13px] text-gray-500 tabular-nums">
                <span>Min: {fmtNum(aggMin)}</span>
                <span>Max: {fmtNum(aggMax)}</span>
              </div>
              <RangeSlider
                min={aggMin} max={aggMax} value={lo} value2={hi}
                onChange={(newLo, newHi) => onChange({ value: String(newLo), value2: String(newHi) })}
              />
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">From</label>
                  <input type="number" value={lo}
                    onChange={(e) => onChange({ value: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
                </div>
                <span className="text-gray-300 mt-4">→</span>
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">To</label>
                  <input type="number" value={hi}
                    onChange={(e) => onChange({ value2: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
                </div>
              </div>
            </div>
          )}

          {mode === "relative" && (
            <div className="p-6 flex flex-col gap-4">
              <div className="flex items-center rounded-md border border-gray-200 p-0.5 w-fit">
                {(["Top", "Bottom"] as const).map((d) => (
                  <button key={d} onClick={() => onChange({ relativeDirection: d })}
                    className={`px-6 py-1.5 rounded text-[13px] font-medium transition-colors
                      ${direction === d ? "bg-indigo-100 text-indigo-600" : "text-gray-500 hover:bg-gray-50"}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">Number of pivot rows</label>
                <input type="number" min={1} value={rule.relativeN ?? 5}
                  onChange={(e) => onChange({ relativeN: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100" />
              </div>
              <p className="text-[12px] text-gray-400">
                Keeps the {direction === "Top" ? "highest" : "lowest"} {rule.relativeN ?? 5} pivot rows by {fn} of {fieldDisplayName(rule.field)}.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-t border-gray-100 bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 text-[13px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors">
            Apply
          </button>
          <button
            onClick={() => onChange({ values: [], value: "", value2: "", relativeDirection: "Top", relativeN: 5 })}
            className="px-4 py-2 text-[13px] text-gray-500 hover:text-gray-700 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// The report's own base filters — the builder's locked-in data scope, create-mode only (the
// call site gates it). View filters, which viewers can tweak, live in ViewFilterPane instead.
// Formula fields only make sense as a number in Values (or a table column), so filter areas
// refuse them while dragging — greyed with the reason at the pointer, like a blocked split.
function useFormulaDropRefusal(flat?: boolean) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const clear = () => setAt(null)
    document.addEventListener("dragend", clear)
    document.addEventListener("drop", clear)
    return () => { document.removeEventListener("dragend", clear); document.removeEventListener("drop", clear) }
  }, [])
  const text = flat ? "Formula fields can only go in Columns" : FORMULA_VALUES_ONLY
  const refuse = (e: React.DragEvent): boolean => {
    if (!activeDrag || !isFormulaKey(activeDrag.field)) return false
    e.dataTransfer.dropEffect = "none"
    setAt({ x: e.clientX, y: e.clientY })
    return true
  }
  return {
    refuse,
    blocked: !!at,
    clear: () => setAt(null),
    tip: at ? <CursorTooltip text={text} at={at} /> : null,
  }
}

function FilterBar({
  rules, dragging, source, fields, aggregations, rangeConfigs, onDrop, onRemove, onRuleChange, justDropped, flat,
}: {
  rules: FilterRule[]
  dragging: boolean
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  onDrop: (name: string, type: FieldType) => void
  onRemove: (field: string) => void
  onRuleChange: (field: string, patch: Partial<FilterRule>) => void
  justDropped: string | null
  // Tabular reports have no pivot groups, so every rule compares the record's own value. The
  // modals use this to hide controls that would be meaningless (see CategoricalFilterModal).
  flat?: boolean
}) {
  const [over, setOver] = useState(false)
  const refusal = useFormulaDropRefusal(flat)

  const handleDragOver = (e: React.DragEvent) => { if (refusal.refuse(e)) return; e.preventDefault(); setOver(true) }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) { setOver(false); refusal.clear() }
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/field")) as { field: string; type: FieldType }
      if (isFormulaKey(data.field)) return
      onDrop(data.field, data.type)
    } catch {}
  }

  const highlight = !refusal.blocked && (over || (dragging && rules.length === 0 && !(activeDrag && isFormulaKey(activeDrag.field))))

  return (
    <div className={`print-hide relative rounded-lg transition-colors
      ${refusal.blocked ? "border-2 border-dashed border-gray-300 bg-gray-100 opacity-60 cursor-not-allowed"
        : highlight ? "border-2 border-dashed border-amber-300 bg-amber-50"
        : rules.length === 0 ? "border-2 border-dashed border-gray-200 bg-gray-50/60"
        : "border border-gray-200 bg-gray-50/60 shadow-sm"}`}
    >
      {refusal.tip}
      {/* Drop target area — filters */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="flex items-center gap-1.5 flex-wrap px-3 pt-2.5 pb-2.5"
      >
        <div className="w-full flex items-center gap-1.5">
          <span className={`text-[11px] font-bold uppercase tracking-wider transition-colors
            ${highlight ? "text-amber-500" : "text-gray-600"}`}>
            Filters
          </span>
          {rules.length > 0 && (
            <span className="text-[10px] bg-gray-200/70 text-gray-600 rounded-full px-1.5 py-px font-medium">{rules.length}</span>
          )}
        </div>
        {rules.length === 0 && (
          <span className={`text-[12px] transition-colors ${highlight ? "text-amber-400" : "text-gray-300"}`}>
            {highlight ? "Release to add" : "Drop fields here"}
          </span>
        )}

        {rules.map((rule) => (
          <FilterChip
            key={rule.field}
            rule={rule}
            allRules={rules}
            source={source}
            fields={fields}
            aggregations={aggregations}
            rangeConfigs={rangeConfigs}
            onRemove={() => onRemove(rule.field)}
            onChange={(patch) => onRuleChange(rule.field, patch)}
            canRemove
            autoOpen={rule.field === justDropped}
            flat={flat}
          />
        ))}
      </div>
    </div>
  )
}

// One filter pill + its configuration modal. Shared by both filter surfaces: the base FILTERS
// bar and the View filters pane. The three flags below are all the two surfaces differ by.
//   canRemove   — show the remove X (build-time action; false for a viewer)
//   autoOpen    — open the modal on mount (a freshly-dropped filter wants configuring; a
//                 view-mode page load does not, or every chip would pop a modal)
//   valueOptions— override the categorical value list (View filters restrict it to values that
//                 survive the base filters, via relevantFieldValues)
//   panelAlign  — which edge the boolean/fallback inline panel hangs off; "right" keeps it from
//                 overflowing when the chip sits in the narrow right-hand pane
// The time-tracked chips a Timeline filter can govern, wherever they sit — Values, Rows or Columns
// in a pivot; Columns or Group by in a tabular report (passed in pivot-shaped).
function timelineMetricItems(fields: PivotFields): PivotItem[] {
  const seen = new Set<string>()
  return [...fields.values, ...fields.rows, ...fields.columns].filter((it) => {
    if (!TIMELINE_METRICS_SET.has(it.field) || seen.has(it.id)) return false
    seen.add(it.id)
    return true
  })
}

// The metrics a Timeline filter governs — all but the exempted ones. With every one exempted, all
// of them, so the period list still has something to describe.
function timelineGovernedKeys(fields: PivotFields, rule: FilterRule): string[] {
  const metrics = timelineMetricItems(fields)
  const governed = metrics.filter((m) => !(rule.tlExempt ?? []).includes(m.id))
  return (governed.length > 0 ? governed : metrics).map((m) => m.field)
}

// The Timeline filter's one addition to the ordinary date modal: which time-tracked metrics it
// governs. All of them by default; unticking one exempts it, and it keeps its own calendar.
// Styled as the role strip ("Matched through") is, since both qualify what the filter acts on.
function TimelineAppliesStrip({ rule, fields, onChange }: {
  rule: FilterRule
  fields: PivotFields
  onChange: (patch: Partial<FilterRule>) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const metrics = timelineMetricItems(fields)
  const exempt = rule.tlExempt ?? []
  const included = metrics.filter((m) => !exempt.includes(m.id)).length
  const toggle = (id: string) =>
    onChange({ tlExempt: exempt.includes(id) ? exempt.filter((x) => x !== id) : [...exempt, id] })
  const label = metrics.length === 0 ? "No time-tracked metrics yet"
    : included === 0 ? "No metrics"
    : included === 1 ? fieldDisplayName(metrics.find((m) => !exempt.includes(m.id))!.field)
    : included === metrics.length ? `All ${metrics.length} time-tracked metrics`
    : `${included} of ${metrics.length} metrics`
  return (
    <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-100 bg-sky-50/50 text-[12px] text-gray-600">
      <span className="shrink-0">Applies to</span>
      <button
        ref={btnRef}
        disabled={metrics.length === 0}
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 font-medium text-sky-700 bg-white border border-sky-200 rounded px-2 py-0.5
          hover:bg-sky-50 transition-colors shrink-0 disabled:text-gray-400 disabled:border-gray-200 disabled:hover:bg-white"
      >
        {label}{metrics.length > 0 && <Ic.ChevDown size={9} />}
      </button>
      <span className="text-gray-400 truncate">Other measures and rows aren't filtered</span>
      {open && (
        <ChipPortalMenu anchorRef={btnRef} onClose={() => setOpen(false)}>
          <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl py-1 w-60 overflow-hidden">
            {metrics.map((m) => {
              const on = !exempt.includes(m.id)
              return (
                <button
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                    ${on ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}>
                    {on && <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </span>
                  {fieldDisplayName(m.field)}
                </button>
              )
            })}
          </div>
        </ChipPortalMenu>
      )}
    </div>
  )
}

function FilterChip({ rule, allRules, source, fields, aggregations, rangeConfigs, onRemove, onChange, canRemove, autoOpen, flat }: {
  rule: FilterRule
  allRules: FilterRule[]
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  onRemove: () => void
  onChange: (patch: Partial<FilterRule>) => void
  canRemove: boolean
  autoOpen: boolean
  flat?: boolean
}) {
  const [open, setOpen] = useState(autoOpen)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const operators = filterOperators(rule.type)
  const needsValue = filterNeedsValue(rule.operator)
  const isRange = filterIsRange(rule.operator)
  const pickerOptions = fieldValues(rule.field, rule.type)
  const usesPicker = needsValue && pickerOptions !== null && !isRange
  const selectedValues: string[] = rule.values ?? []
  const isDateField = rule.type === "date"
  const isCategoricalField = rule.type === "text" || rule.type === "person"
  const isNumericField = isNumericType(rule.type)

  useEffect(() => {
    if (!open || isDateField || isCategoricalField || isNumericField) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open, isDateField, isCategoricalField, isNumericField])

  const toggleValue = (v: string) => {
    const next = selectedValues.includes(v)
      ? selectedValues.filter((x) => x !== v)
      : [...selectedValues, v]
    onChange({ values: next })
  }

  const filteredOptions = pickerOptions
    ? pickerOptions.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : []

  const inputClass = "border border-gray-200 rounded px-2 py-1 text-[12px] text-gray-700 w-full focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"

  // Chip summary label
  const dateSummary = (() => {
    if (!isDateField) return ""
    const mode = rule.dateMode ?? "actual"
    if (mode === "actual") {
      if (selectedValues.length === 0) return filterGranLabel(rule.dateGranularity || "")
      return selectedValues.length === 1 ? selectedValues[0] : `${selectedValues.length} selected`
    }
    if (mode === "range") {
      const op = rule.dateRangeOp ?? "after"
      if (op === "between" && rule.dateFrom && rule.dateTo) return `${rule.dateFrom} – ${rule.dateTo}`
      return rule.dateFrom ? `${op} ${rule.dateFrom}` : op
    }
    if (mode === "relative") {
      const opt = rule.dateRelativeOpt
      if (!opt) return "relative"
      return isNInput(opt) ? opt.replace("N", String(rule.dateRelativeN || 1)) : opt
    }
    return ""
  })()

  const WILDCARD_VERB: Record<WildcardMatchType, string> = {
    "Exactly Matches": "is", "Does Not Match": "is not",
    "Contains": "contains", "Does Not Contain": "doesn't contain",
    "Starts With": "starts with", "Does Not Start With": "doesn't start with",
    "Ends With": "ends with", "Does Not End With": "doesn't end with",
  }
  const catSummary = (() => {
    if (!isCategoricalField) return ""
    const treatment = rule.catTreatment ?? "categorical"
    if (treatment !== "categorical") {
      // Count/Distinct-Count treatment reuses the same numMode-driven shape as numSummary.
      const nMode = rule.numMode ?? "actual"
      if (nMode === "actual") {
        if (selectedValues.length === 0) return ""
        return selectedValues.length === 1 ? selectedValues[0] : `${selectedValues.length} selected`
      }
      if (nMode === "range") {
        if (!rule.value && !rule.value2) return ""
        const lo = rule.value !== "" ? rule.value : "min"
        const hi = rule.value2 !== "" ? rule.value2 : "max"
        return `${lo} – ${hi}`
      }
      return `${rule.relativeDirection ?? "Top"} ${rule.relativeN ?? 5}`
    }
    if ((rule.catMode ?? "actual") === "wildcard") {
      const conds = (rule.wildcardConditions ?? []).filter((c) => (c.value ?? "").trim() !== "")
      if (conds.length === 0) return ""
      if (conds.length === 1) return `${WILDCARD_VERB[conds[0].matchType]} '${conds[0].value}'`
      return `${conds.length} conditions`
    }
    // A current-user rule has no ticked values to describe — without this the chip would fall
    // back to "Actual" and give no hint that it answers differently for each viewer.
    if (rule.catMatchMode === "me") return "is me"
    if (rule.catMatchMode === "notMe") return "is not me"
    if (selectedValues.length === 0) return ""
    const base = selectedValues.length === 1 ? selectedValues[0] : `${selectedValues.length} selected`
    const matchMode = rule.catMatchMode ?? "any"
    if (matchMode === "none") return `None of ${base}`
    if (matchMode === "all") return `All of ${base}`
    if (matchMode === "only") return `Only ${base}`
    return base
  })()

  const numSummary = (() => {
    if (!isNumericField) return ""
    const mode = rule.numMode ?? "actual"
    if (mode === "actual") {
      if (selectedValues.length === 0) return ""
      return selectedValues.length === 1 ? fmtNum(Number(selectedValues[0])) : `${selectedValues.length} selected`
    }
    if (mode === "range") {
      if (!rule.value && !rule.value2) return ""
      const lo = rule.value !== "" ? fmtNum(Number(rule.value)) : "min"
      const hi = rule.value2 !== "" ? fmtNum(Number(rule.value2)) : "max"
      return `${lo} – ${hi}`
    }
    return `${rule.relativeDirection ?? "Top"} ${rule.relativeN ?? 5}`
  })()

  const isTimeline = rule.field === TIMELINE_KEY
  // A date summary, plus how many metrics it governs once any are exempt.
  const timelineSummary = (() => {
    if (!isTimeline) return ""
    const metrics = timelineMetricItems(fields)
    const included = metrics.filter((m) => !(rule.tlExempt ?? []).includes(m.id)).length
    return metrics.length > 0 && included < metrics.length
      ? `${dateSummary} · ${included} of ${metrics.length} metrics` : dateSummary
  })()
  const summaryValue = isTimeline
    ? timelineSummary
    : isDateField
    ? dateSummary
    : isCategoricalField
      ? catSummary
      : isNumericField
        ? numSummary
        : usesPicker
          ? selectedValues.length === 0 ? "" : selectedValues.length === 1 ? selectedValues[0] : `${selectedValues.length} selected`
          : rule.value

  return (
    <div ref={ref} className="relative animate-chip-in">
      {/* Chip pill */}
      <button
        onClick={() => setOpen((p) => !p)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] font-medium transition-colors
          ${open
            ? "bg-white border-indigo-300 text-indigo-700 shadow-sm"
            : "bg-white border-gray-200 text-gray-700 hover:border-gray-300"}`}
      >
        {fieldTypeIcon(rule.type, 11)}
        <span>{fieldDisplayName(rule.field)}</span>
        {/* The relationship, where there is a choice — "Team member name is me" means different
            people depending on whether it is read as owner, creator or member. */}
        {(() => {
          const g = pickGrain(source, fields, allRules)
          const opts = availableLookupPaths(g, rule.field, source)
          if (opts.length < 2) return null
          const chosen = normalizeRoleId(rule.lookupPath)
          const role = chosen && opts.includes(chosen) ? chosen : defaultLookupPath(opts)!
          return <span className="text-sky-700 font-normal">via {roleDisplayName(role)}</span>
        })()}
        {!isDateField && !isCategoricalField && !isNumericField && rule.operator && (
          <span className="text-gray-400 font-normal">{rule.operator}</span>
        )}
        {isDateField && rule.dateMode && (
          <span className="text-gray-400 font-normal capitalize">{rule.dateMode}</span>
        )}
        {isCategoricalField && (
          <span className="text-gray-400 font-normal">
            {rule.catTreatment === "count" ? "Count"
              : rule.catTreatment === "distinctCount" ? "Distinct Count"
              : <span className="capitalize">{rule.catMode ?? "actual"}</span>}
          </span>
        )}
        {isNumericField && (
          <span className="text-gray-400 font-normal">
            {rule.numFunction || "Sum"} <span className="capitalize">{rule.numMode ?? "actual"}</span>
          </span>
        )}
        {summaryValue && (
          <span className="max-w-[120px] truncate text-indigo-600">{summaryValue}</span>
        )}
        <Ic.ChevDown size={10} />

        {canRemove && (
          <span
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            className="text-gray-300 hover:text-gray-600 transition-colors ml-0.5"
          >
            <Ic.X size={10} />
          </span>
        )}
      </button>

      {/* Date modal */}
      {open && isDateField && (
        <DateFilterModal
          rule={rule} onChange={onChange} onClose={() => setOpen(false)}
          strip={isTimeline
            ? <TimelineAppliesStrip rule={rule} fields={fields} onChange={onChange} />
            : <FilterRoleStrip grainModule={pickGrain(source, fields, allRules)} source={source} rule={rule} onChange={onChange} />}
          timelineMetricKeys={isTimeline ? timelineGovernedKeys(fields, rule) : undefined}
        />
      )}

      {/* Categorical (text/person) modal */}
      {open && isCategoricalField && (
        <CategoricalFilterModal
          rule={rule} allRules={allRules} source={source} fields={fields} aggregations={aggregations} rangeConfigs={rangeConfigs}
          flat={flat}
          onChange={onChange} onClose={() => setOpen(false)}
        />
      )}

      {/* Numeric modal */}
      {open && isNumericField && (
        <NumericFilterModal
          rule={rule} allRules={allRules} source={source} fields={fields} aggregations={aggregations} rangeConfigs={rangeConfigs}
          flat={flat}
          onChange={onChange} onClose={() => setOpen(false)}
        />
      )}

      {/* Boolean inline panel */}
      {open && !isDateField && !isCategoricalField && !isNumericField && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-2xl w-72 overflow-hidden">
          <FilterRoleStrip grainModule={pickGrain(source, fields, allRules)} source={source} rule={rule} onChange={onChange} compact />
          <div className="p-4 pb-3">
            {/* Field label */}
            <div className="flex items-center gap-2 mb-3">
              {fieldTypeIcon(rule.type, 13)}
              <span className="text-[13px] font-semibold text-gray-800">{fieldDisplayName(rule.field)}</span>
              <span className="ml-auto text-[10px] text-gray-400 capitalize">{rule.type}</span>
            </div>

            {/* Operator select */}
            <div className="mb-3">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">Condition</label>
              <select
                value={rule.operator}
                onChange={(e) => onChange({ operator: e.target.value, values: [], value: "", value2: "" })}
                className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 bg-white"
              >
                {operators.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Multi-select value picker */}
          {usesPicker && (
            <div className="border-t border-gray-100">
              {/* Search within picker */}
              <div className="px-3 py-2 border-b border-gray-100">
                <div className="flex items-center gap-2 bg-gray-50 rounded-md px-2.5 py-1.5">
                  <Ic.Search />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search values…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 bg-transparent text-[12px] text-gray-700 placeholder-gray-400 focus:outline-none"
                  />
                  {search && (
                    <button onClick={() => setSearch("")} className="text-gray-300 hover:text-gray-500">
                      <Ic.X size={11} />
                    </button>
                  )}
                </div>
              </div>

              {/* Select all / clear row */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 bg-gray-50">
                <span className="text-[11px] text-gray-400">
                  {selectedValues.length} of {pickerOptions!.length} selected
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => onChange({ values: pickerOptions! })}
                    className="text-[11px] text-indigo-500 hover:text-indigo-700 font-medium"
                  >
                    All
                  </button>
                  <button
                    onClick={() => onChange({ values: [] })}
                    className="text-[11px] text-gray-400 hover:text-gray-600"
                  >
                    None
                  </button>
                </div>
              </div>

              {/* Option list */}
              <div className="overflow-y-auto max-h-48">
                {filteredOptions.length === 0 ? (
                  <p className="text-[12px] text-gray-400 text-center py-4">No matches</p>
                ) : (
                  filteredOptions.map((v) => {
                    const checked = selectedValues.includes(v)
                    return (
                      <button
                        key={v}
                        onClick={() => toggleValue(v)}
                        className={`flex items-center gap-2.5 w-full px-3 py-2 text-[13px] text-left transition-colors
                          ${checked ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-50"}`}
                      >
                        {/* Checkbox */}
                        <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors
                          ${checked ? "bg-indigo-600 border-indigo-600" : "border-gray-300"}`}
                        >
                          {checked && (
                            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                              <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </span>
                        <span className="truncate">{v}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}

          {/* Free-text / number / date input (when no picker) */}
          {needsValue && !usesPicker && (
            <div className="px-4 pb-3 border-t border-gray-100 pt-3">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">
                {isRange ? "From" : "Value"}
              </label>
              {rule.type === "date" ? (
                <input type="date" value={rule.value} onChange={(e) => onChange({ value: e.target.value })} className={inputClass} />
              ) : isNumericType(rule.type) ? (
                <input type="number" placeholder="Enter number" value={rule.value} onChange={(e) => onChange({ value: e.target.value })} className={inputClass} />
              ) : (
                <input type="text" placeholder="Enter value" value={rule.value} onChange={(e) => onChange({ value: e.target.value })} className={inputClass} />
              )}
              {isRange && (
                <>
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mt-2 mb-1">To</label>
                  {rule.type === "date" ? (
                    <input type="date" value={rule.value2} onChange={(e) => onChange({ value2: e.target.value })} className={inputClass} />
                  ) : (
                    <input type="number" placeholder="Enter number" value={rule.value2} onChange={(e) => onChange({ value2: e.target.value })} className={inputClass} />
                  )}
                </>
              )}
            </div>
          )}

          {/* Apply / Clear footer */}
          <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50">
            <button
              onClick={() => setOpen(false)}
              className="flex-1 py-1.5 text-[12px] font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors"
            >
              Apply
            </button>
            <button
              onClick={() => onChange({ value: "", value2: "", values: [], operator: operators[0] })}
              className="px-3 py-1.5 text-[12px] text-gray-500 hover:text-gray-700 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// A relative-period picker on one line. "Last N quarters" reads as "Last [6] quarters", with the
// count typed in place, instead of a dropdown with a separate number box under it.
function RelativePeriodControl({ options, value, n, onChange, onNChange }: {
  options: string[]; value: string; n: number
  onChange: (opt: string) => void; onNChange: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const m = value.match(/^(Last|Next) N (.+)$/)
  return (
    <div ref={ref} className="flex items-center w-full border border-gray-200 rounded-md bg-white px-2 py-1 text-[12px] text-gray-700">
      {m ? (
        <>
          <span className="cursor-pointer" onClick={() => setOpen((p) => !p)}>{m[1]}</span>
          <input
            type="number" min={1} value={n}
            onChange={(e) => onNChange(Math.max(1, Number(e.target.value) || 1))}
            className="w-10 mx-1.5 px-1 py-0.5 text-center text-gray-800 border border-gray-200 rounded focus:outline-none focus:border-indigo-400"
          />
          <span className="flex-1 cursor-pointer" onClick={() => setOpen((p) => !p)}>{m[2]}</span>
        </>
      ) : (
        <span className="flex-1 cursor-pointer py-0.5" onClick={() => setOpen((p) => !p)}>{value || "(Any time)"}</span>
      )}
      <button onClick={() => setOpen((p) => !p)} className="text-gray-400 hover:text-gray-600 shrink-0 ml-1"><Ic.ChevDown size={10} /></button>
      {open && (
        <ChipPortalMenu anchorRef={ref} onClose={() => setOpen(false)}>
          <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl py-1 w-52">
            {["", ...options].map((o) => (
              <button key={o || "any"} onClick={() => { onChange(o); setOpen(false) }}
                className={`flex items-center justify-between w-full px-3 py-1.5 text-[12px] text-left hover:bg-indigo-50
                  ${o === value ? "text-indigo-700 font-medium" : "text-gray-700"}`}>
                {o ? o.replace(/ N /, " … ") : "(Any time)"}
                {o === value && <Ic.Check />}
              </button>
            ))}
          </div>
        </ChipPortalMenu>
      )}
    </div>
  )
}

// ── View filters pane ──────────────────────────────────────────────────────────

// One view filter, rendered as an always-open inline control rather than a chip that opens a
// modal — a viewer should be able to see and change the criteria without discovering a click
// target first. The control follows the field's type:
//   text / person / boolean  → multi-select checkbox list (with "(All)")
//   date (Actual mode)       → the same list, over the granularity's period labels
//   number / money / …       → dual-handle range slider over the group aggregate
// The gear still opens the full modal, so nothing the modal offers (wildcards, all-of/only,
// Top-N, relative dates) is lost — the card is the default, not a replacement.
// Builder-only configuration for one view filter, in a floating popup anchored to the card's
// gear. Mirrors the reference tool's shape: a display-name override, a component-type picker,
// and (for a measure) which aggregate the filter compares. Deliberately excludes the base
// filter modals' power tools — wildcard matching, single-value sliders, Top-N — because a view
// filter is meant to be a simple pick-values-or-a-range control for a viewer.
function ViewFilterSettings({ rule, options, anchorRef, flat, onChange, onClose }: {
  rule: FilterRule
  options: string[]
  flat?: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onChange: (patch: Partial<FilterRule>) => void
  onClose: () => void
}) {
  const isNumericField = isNumericType(rule.type)
  const isDateField = rule.type === "date"
  const componentList = viewFilterComponents(rule.type)
  const current = resolveViewFilterComponent(rule)
  const listMode = rule.vfListMode ?? "all"
  const offered: string[] = rule.vfOfferedValues ?? []
  const selectCls = "w-full border border-gray-200 rounded-md px-2 py-1.5 text-[12px] text-gray-700 bg-white focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"

  const toggleOffered = (v: string) =>
    onChange({ vfOfferedValues: offered.includes(v) ? offered.filter((x) => x !== v) : [...offered, v] })

  return (
    <ChipPortalMenu anchorRef={anchorRef} onClose={onClose}>
      <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl w-72 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50">
          <Ic.Gear size={12} />
          <span className="text-[12px] font-semibold text-gray-800 flex-1 truncate">Filter settings</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 transition-colors">
            <Ic.X size={12} />
          </button>
        </div>

        <div className="px-3 py-3 flex flex-col gap-3 max-h-[420px] overflow-y-auto">
          {/* Display name */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">
              Filter display name <span className="text-gray-400">({rule.field.replace("::", ".")})</span>
            </label>
            <input
              type="text"
              value={rule.vfDisplayName ?? ""}
              placeholder={fieldDisplayName(rule.field)}
              onChange={(e) => onChange({ vfDisplayName: e.target.value })}
              className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-[12px] text-gray-800 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
            />
          </div>

          {/* Component type — a date pairs a period-type picker with the widget picker, since
              "which periods" and "how they're presented" are separate choices. */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">{isNumericField ? "Viewers filter with" : "Viewers can pick"}</label>
            {isDateField && (
              <select
                value={rule.dateMode ?? "actual"}
                onChange={(e) => {
                  // Each period type reads different fields off the rule, so clear the others'
                  // criteria rather than leaving a stale window driving the report.
                  const mode = e.target.value as "actual" | "relative" | "range"
                  onChange({
                    dateMode: mode, values: [],
                    dateFrom: "", dateTo: "", dateRelativeOpt: "", dateRelativeN: 1,
                  })
                }}
                className={`${selectCls} mb-1.5`}
              >
                {VF_DATE_PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            )}
            {(!isDateField || (rule.dateMode ?? "actual") === "actual") && (
            <select
              value={current}
              onChange={(e) => {
                const next = e.target.value as ViewFilterComponent
                // Switching between a range and a value list changes which fields the engine
                // reads, so reset the criteria rather than leaving stale bounds/checks behind.
                const reset = isNumericField
                  ? next === "sliderDouble"
                    ? { numMode: "range" as const, value: "", value2: "", values: [] }
                    : { numMode: "actual" as const, value: "", value2: "", values: [] }
                  : { values: [] }
                onChange({ vfComponent: next, ...reset })
              }}
              className={selectCls}
            >
              {componentList.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
            )}
          </div>

          {/* Relative: the granularity decides which relative periods the viewer's list offers
              (This month, Last N months… or This quarter, Last N quarters…). */}
          {isDateField && (rule.dateMode ?? "actual") === "relative" && (
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">Granularity</label>
              <select
                value={rule.dateGranularity || "Month & Year"}
                onChange={(e) => onChange({ dateGranularity: e.target.value, dateRelativeOpt: "", dateRelativeN: 1 })}
                className={selectCls}
              >
                {FILTER_GRANULARITIES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </div>
          )}

          {/* Range: the dates a viewer may pick between. */}
          {isDateField && (rule.dateMode ?? "actual") === "range" && (
            <div>
              <label className="text-[11px] text-gray-500 block mb-1.5">Choose values</label>
              <div className="bg-gray-50 rounded-md px-2.5 py-2 flex flex-col gap-2">
                <div className="flex items-center gap-4">
                  {([["any", "Any date range"], ["specified", "Specified date range"]] as const).map(([key, label]) => (
                    <label key={key} onClick={() => onChange({ vfRangeLimit: key })} className="flex items-center gap-1.5 cursor-pointer select-none">
                      <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center
                        ${(rule.vfRangeLimit ?? "any") === key ? "border-indigo-600" : "border-gray-300"}`}>
                        {(rule.vfRangeLimit ?? "any") === key && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
                      </span>
                      <span className="text-[11px] text-gray-700">{label}</span>
                    </label>
                  ))}
                </div>
                {(rule.vfRangeLimit ?? "any") === "specified" && (
                  <div className="grid grid-cols-[32px_1fr] items-center gap-x-1.5 gap-y-1.5">
                    <span className="text-[11px] text-gray-500">From</span>
                    <input type="date" value={rule.vfRangeFrom ?? ""} max={rule.vfRangeTo || undefined}
                      onChange={(e) => onChange({ vfRangeFrom: e.target.value })}
                      className={`${selectCls} min-w-0`} />
                    <span className="text-[11px] text-gray-500">To</span>
                    <input type="date" value={rule.vfRangeTo ?? ""} min={rule.vfRangeFrom || undefined}
                      onChange={(e) => onChange({ vfRangeTo: e.target.value })}
                      className={`${selectCls} min-w-0`} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Aggregate — only meaningful when there are groups to aggregate over */}
          {isNumericField && !flat && (
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">Choose function to apply</label>
              <select
                value={rule.numFunction || "Sum"}
                onChange={(e) => onChange({ numFunction: e.target.value, value: "", value2: "", values: [] })}
                className={selectCls}
              >
                {AGG_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          )}

          {/* Which values the viewer's list offers. Hidden for a date unless it's picking
              actual periods — a relative window or a from/to range has no list to populate. */}
          {!isNumericField && (!isDateField || (rule.dateMode ?? "actual") === "actual") && (
            <div>
              <label className="text-[11px] text-gray-500 block mb-1.5">Choose values</label>
              {/* Granularity decides WHICH periods the list holds (Years, Month & Year, …), so
                  it belongs with the value list, not the component picker. */}
              {isDateField && (
                <select
                  value={rule.dateGranularity || "Month & Year"}
                  onChange={(e) => onChange({ dateGranularity: e.target.value, values: [], vfOfferedValues: [] })}
                  className={`${selectCls} mb-1.5`}
                >
                  {FILTER_GRANULARITIES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
              )}
              <div className="flex items-center gap-4 bg-gray-50 rounded-md px-2.5 py-2">
                {([["all", "List all values"], ["selected", "List selected values"]] as const).map(([key, label]) => (
                  <label key={key} onClick={() => onChange({ vfListMode: key })} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center
                      ${listMode === key ? "border-indigo-600" : "border-gray-300"}`}>
                      {listMode === key && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
                    </span>
                    <span className="text-[11px] text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
              {listMode === "selected" && (
                <div className="mt-2 border border-gray-200 rounded-md max-h-40 overflow-y-auto py-1">
                  {options.length === 0 ? (
                    <p className="px-2.5 py-1.5 text-[11px] text-gray-400">No values available.</p>
                  ) : options.map((v) => (
                    <label key={v} onClick={() => toggleOffered(v)} className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-gray-700 cursor-pointer hover:bg-indigo-50 select-none">
                      <span className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 text-white
                        ${offered.includes(v) ? "bg-indigo-600 border-indigo-600" : "bg-white border-gray-300"}`}>
                        {offered.includes(v) && <Ic.Check />}
                      </span>
                      <span className="truncate">{v}</span>
                    </label>
                  ))}
                </div>
              )}
              {listMode === "selected" && offered.length === 0 && (
                <p className="text-[10px] text-amber-600 mt-1">Nothing picked yet — the viewer's list will be empty.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </ChipPortalMenu>
  )
}

// One view filter, rendered as an always-open inline control rather than a chip that opens a
// modal — a viewer should see and change the criteria without hunting for a click target. The
// control follows the field type's default (checkbox list for a category, double slider for a
// measure) unless the builder picked another via the gear's settings popup.
function ViewFilterCard({ rule, baseRules, source, fields, aggregations, rangeConfigs, valueOptions, isCreate, flat, onRemove, onChange }: {
  rule: FilterRule
  baseRules: FilterRule[]
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  valueOptions?: string[] | null
  isCreate: boolean
  flat?: boolean
  onRemove: () => void
  onChange: (patch: Partial<FilterRule>) => void
}) {
  const [showSettings, setShowSettings] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [search, setSearch] = useState("")
  const [tipAt, setTipAt] = useState<{ x: number; y: number } | null>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownBtnRef = useRef<HTMLButtonElement>(null)

  const isNumericField = isNumericType(rule.type)
  const isDateField = rule.type === "date"
  const component = resolveViewFilterComponent(rule)
  const selected: string[] = rule.values ?? []
  const label = (rule.vfDisplayName ?? "").trim() !== "" ? rule.vfDisplayName : fieldDisplayName(rule.field)

  // Numeric cards work off the same group-level aggregate the filter compares, computed over
  // base-filtered data only — so the track's ends are reachable values, not dataset-wide
  // extremes the base scope already excluded.
  const aggFn = rule.numFunction || "Sum"
  const aggValues = !isNumericField
    ? []
    : flat
      // A flat report's slider must span the records' own values; the pivot's per-group
      // aggregates would collapse to a single point with no row grouping to vary them.
      ? flatFieldNumericValues(source, fields, baseRules, baseRules, rule.field)
      : previewGroupAggregates(source, fields, aggregations, baseRules, rule.field, aggFn, rangeConfigs)
  const boundLo = aggValues.length ? Math.min(...aggValues) : 0
  const boundHi = aggValues.length ? Math.max(...aggValues) : 0
  const lo = rule.value !== "" && rule.value != null ? Number(rule.value) : boundLo
  const hi = rule.value2 !== "" && rule.value2 != null ? Number(rule.value2) : boundHi

  // The full set of values this field could offer. Date uses its granularity's period labels;
  // a numeric Multi Select Box uses the distinct aggregates; everything else uses the
  // base-filtered value list threaded in from the pane.
  const allOptions = isNumericField
    ? [...new Set(aggValues)].sort((a, b) => a - b).map(String)
    : rule.field === TIMELINE_KEY
      // The periods the governed metrics have records in — exemptions come from the report's
      // own Timeline filter, if it has one.
      ? timelineActualValues(
          timelineGovernedKeys(fields, baseRules.find((r) => r.field === TIMELINE_KEY) ?? rule),
          rule.dateGranularity || "Month & Year",
          timelineRuleWindow(baseRules.find((r) => r.field === TIMELINE_KEY)))
    : isDateField
      ? (ACTUAL_DATE_VALUES[rule.dateGranularity || "Month & Year"] ?? [])
      : (valueOptions ?? [])

  // "List selected values" narrows what the viewer may pick to the builder's allow-list.
  const options = (!isNumericField && (rule.vfListMode ?? "all") === "selected")
    ? allOptions.filter((v) => (rule.vfOfferedValues ?? []).includes(v))
    : allOptions

  // An empty `values` means "no filter" everywhere in this engine, so it must render as every
  // box ticked — anything else would misreport what the report is actually doing.
  // "Only me" keeps the list on screen but read-only, showing exactly what the filter does:
  // just the viewer ticked. Rendering it as all-ticked (what an empty `values` normally means)
  // would claim the report shows everyone while it shows one person.
  const onlyMe = rule.type === "person" && rule.catMatchMode === "me"
  const meName = getCurrentUserName().toLowerCase()
  const allSelected = !onlyMe && selected.length === 0
  const isChecked = (v: string) => onlyMe ? v.toLowerCase() === meName : (allSelected || selected.includes(v))
  const checkedCount = onlyMe ? 1 : allSelected ? options.length : selected.length

  // Unchecking the last remaining value is refused rather than written through: `values: []`
  // would read back as "no filter" and silently re-tick every box, misrepresenting the report.
  const toggleValue = (v: string) => {
    if (onlyMe) return
    const current = allSelected ? options : selected
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v]
    if (next.length === 0) return
    const patch: Partial<FilterRule> = { values: next.length === options.length ? [] : next }
    if (isNumericField) patch.numMode = "actual"
    onChange(patch)
  }
  const pickSingle = (v: string) => {
    if (onlyMe) return
    const patch: Partial<FilterRule> = { values: v === "" ? [] : [v] }
    if (isNumericField) patch.numMode = "actual"
    onChange(patch)
  }

  const filtered = options.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
  const summary = onlyMe ? "Only me" : allSelected ? "All" : selected.length === 1 ? selected[0] : `${selected.length} selected`
  const checkboxCls = (on: boolean) =>
    `w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 text-white ${on ? "bg-indigo-600 border-indigo-600" : "bg-white border-gray-300"}`

  const searchBox = options.length > 8 && (
    <div className="px-2 pt-2">
      <div className="flex items-center gap-1.5 bg-gray-50 rounded px-2 py-1">
        <Ic.Search />
        <input
          type="text" placeholder="Search…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={onlyMe}
          className="flex-1 min-w-0 bg-transparent text-[11px] text-gray-700 placeholder-gray-400 focus:outline-none"
        />
      </div>
    </div>
  )

  const checkList = (
    <div className="max-h-48 overflow-y-auto py-1">
      {!search && (
        <label
          onClick={() => { if (!onlyMe && !allSelected) onChange(isNumericField ? { values: [], numMode: "actual" } : { values: [] }) }}
          title={onlyMe ? undefined : allSelected ? "At least one value must stay selected" : "Select all"}
          className={`flex items-center gap-2 px-2.5 py-1 text-[12px] text-gray-700 select-none
            ${allSelected ? "cursor-default" : "cursor-pointer hover:bg-indigo-50"}`}
        >
          <span className={checkboxCls(allSelected)}>{allSelected && <Ic.Check />}</span>
          (All)
        </label>
      )}
      {filtered.map((v) => {
        const on = isChecked(v)
        const isLast = on && checkedCount === 1
        return (
          <label
            key={v}
            onClick={() => toggleValue(v)}
            title={isLast ? "At least one value must stay selected" : undefined}
            className={`flex items-center gap-2 px-2.5 py-1 text-[12px] text-gray-700 select-none
              ${isLast ? "cursor-default" : "cursor-pointer hover:bg-indigo-50"}`}
          >
            <span className={checkboxCls(on)}>{on && <Ic.Check />}</span>
            <span className="truncate">{isNumericField ? fmtNum(Number(v)) : v}</span>
          </label>
        )
      })}
      {filtered.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-gray-400">No matching values.</p>}
    </div>
  )

  const radioList = (
    <div className="max-h-48 overflow-y-auto py-1">
      {!search && (
        <label
          onClick={() => pickSingle("")}
          className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-gray-700 cursor-pointer hover:bg-indigo-50 select-none"
        >
          <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${allSelected ? "border-indigo-600" : "border-gray-300"}`}>
            {allSelected && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
          </span>
          (All)
        </label>
      )}
      {filtered.map((v) => {
        const on = onlyMe ? v.toLowerCase() === meName : !allSelected && selected[0] === v
        return (
          <label
            key={v}
            onClick={() => pickSingle(v)}
            className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-gray-700 cursor-pointer hover:bg-indigo-50 select-none"
          >
            <span className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? "border-indigo-600" : "border-gray-300"}`}>
              {on && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
            </span>
            <span className="truncate">{v}</span>
          </label>
        )
      })}
    </div>
  )

  const selectCls = "w-full border border-gray-200 rounded-md px-2 py-1 text-[12px] text-gray-700 bg-white focus:outline-none focus:border-indigo-400"

  const dateMode = rule.dateMode ?? "actual"
  const relOptions = RELATIVE_OPTIONS[rule.dateGranularity || "Month & Year"] ?? []

  let body: ReturnType<typeof ViewFilterSettings> | null = null
  if (isDateField && dateMode === "relative") {
    // A relative window is inherently one choice, so it's a single select regardless of the
    // component picker (which the settings popup hides for this period type).
    body = (
      <div className="px-2.5 py-2">
        <RelativePeriodControl
          options={relOptions}
          value={rule.dateRelativeOpt || ""}
          n={rule.dateRelativeN || 1}
          onChange={(opt) => onChange({ dateRelativeOpt: opt })}
          onNChange={(n) => onChange({ dateRelativeN: n })}
        />
      </div>
    )
  } else if (isDateField && dateMode === "range") {
    const op = rule.dateRangeOp ?? "after"
    // The builder can limit the dates a viewer may pick ("Specified date range").
    const limited = rule.vfRangeLimit === "specified"
    const minD = limited && rule.vfRangeFrom ? rule.vfRangeFrom : undefined
    const maxD = limited && rule.vfRangeTo ? rule.vfRangeTo : undefined
    const clamp = (v: string) => (!v ? v : minD && v < minD ? minD : maxD && v > maxD ? maxD : v)
    body = (
      <div className="px-2.5 py-2 flex flex-col gap-1.5">
        <select
          value={op}
          onChange={(e) => onChange({ dateRangeOp: e.target.value as FilterRule["dateRangeOp"] })}
          className={selectCls}
        >
          <option value="after">On or after</option>
          <option value="before">On or before</option>
          <option value="between">Between</option>
        </select>
        <input
          type="date" value={rule.dateFrom || ""} min={minD} max={maxD}
          onChange={(e) => onChange({ dateFrom: clamp(e.target.value) })}
          className={selectCls}
        />
        {op === "between" && (
          <input
            type="date" value={rule.dateTo || ""} min={rule.dateFrom || minD} max={maxD}
            onChange={(e) => onChange({ dateTo: clamp(e.target.value) })}
            className={selectCls}
          />
        )}
        {(minD || maxD) && (
          <p className="text-[10px] text-gray-400">
            {minD && maxD ? `${fmtCalDate(minD)} – ${fmtCalDate(maxD)}` : minD ? `From ${fmtCalDate(minD)}` : `Until ${fmtCalDate(maxD!)}`}
          </p>
        )}
      </div>
    )
  } else if (component === "sliderDouble") {
    body = (
      <div className="px-3 pt-3 pb-2.5">
        <RangeSlider
          min={boundLo} max={boundHi} value={lo} value2={hi}
          onChange={(a, b) => onChange({ numMode: "range", value: String(a), value2: String(b) })}
        />
        <div className="flex items-center justify-between mt-1 text-[11px] text-gray-500 tabular-nums">
          <span>{fmtNum(lo)}</span>
          <span>{fmtNum(hi)}</span>
        </div>
      </div>
    )
  } else if (component === "singleDropdown") {
    body = (
      <div className="px-2.5 py-2">
        <select value={allSelected ? "" : (selected[0] ?? "")} onChange={(e) => pickSingle(e.target.value)} className={selectCls}>
          <option value="">(All)</option>
          {options.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
    )
  } else if (component === "multiDropdown" || component === "multiSelectBox") {
    body = (
      <div className="px-2.5 py-2">
        <button
          ref={dropdownBtnRef}
          onClick={() => { if (!onlyMe) setShowDropdown((p) => !p) }}
          className="w-full flex items-center gap-1.5 border border-gray-200 rounded-md px-2 py-1 text-[12px] text-gray-700 bg-white hover:border-gray-300 transition-colors"
        >
          <span className="flex-1 truncate text-left">{summary}</span>
          <Ic.ChevDown size={10} />
        </button>
        {showDropdown && (
          <ChipPortalMenu anchorRef={dropdownBtnRef} onClose={() => setShowDropdown(false)}>
            <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-2xl w-60 overflow-hidden">
              {searchBox}
              {checkList}
            </div>
          </ChipPortalMenu>
        )}
      </div>
    )
  } else if (component === "multiCustomList") {
    body = (
      <div className="px-2.5 py-2">
        <textarea
          rows={4}
          value={selected.join("\n")}
          placeholder={"One value per line…\ne.g.\n" + (options.slice(0, 2).join("\n") || "")}
          onChange={(e) => onChange({ values: e.target.value.split("\n").map((s) => s.trim()).filter((s) => s !== "") })}
          className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-[11px] text-gray-700 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 resize-y"
        />
        <p className="text-[10px] text-gray-400 mt-1">Empty matches everything.</p>
      </div>
    )
  } else if (component === "singleList") {
    body = <>{searchBox}{radioList}</>
  } else {
    body = <>{searchBox}{checkList}</>
  }

  return (
    <div className="w-full border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden animate-chip-in">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-gray-100 bg-gray-50/70">
        <span className="shrink-0">{fieldTypeIcon(rule.type, 11)}</span>
        <span className="text-[12px] font-semibold text-gray-700 truncate flex-1" title={rule.field.replace("::", ": ")}>
          {label}
        </span>
        {isNumericField && <span className="text-[10px] text-gray-400 shrink-0">{aggFn}</span>}
        {/* Settings is builder-only — a viewer changes the filter's criteria, not how it's presented */}
        {isCreate && (
          <button
            ref={settingsBtnRef}
            onClick={() => setShowSettings((p) => !p)}
            title="Filter settings"
            className={`transition-colors shrink-0 p-0.5 rounded hover:bg-gray-200/60 ${showSettings ? "text-indigo-600" : "text-gray-300 hover:text-gray-600"}`}
          >
            <Ic.Gear size={11} />
          </button>
        )}
        {isCreate && (
          <button onClick={onRemove} title="Remove" className="text-gray-300 hover:text-gray-600 transition-colors shrink-0 p-0.5 rounded hover:bg-gray-200/60">
            <Ic.X size={11} />
          </button>
        )}
      </div>

      <FilterRoleStrip
        grainModule={pickGrain(source, fields, [...baseRules, rule])}
        source={source}
        rule={rule}
        onChange={onChange}
        compact
        readOnly={!isCreate}
      />

      {/* "Only me" sits above whichever control the builder chose. It is a toggle rather than a
          "Me" entry in the list because the list starts all-ticked and clicking a name UNticks it —
          isolating yourself would take a click per colleague, and "Me" would duplicate your name. */}
      {rule.type === "person" && (
        <label className="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-100 text-[12px] cursor-pointer select-none hover:bg-gray-50">
          <input
            type="checkbox"
            checked={rule.catMatchMode === "me"}
            onChange={() => onChange({ catMatchMode: rule.catMatchMode === "me" ? "any" : "me" })}
            className="w-3.5 h-3.5 accent-indigo-600"
          />
          <span className="text-gray-700 font-medium">Only me</span>
          <span className="text-gray-400 truncate">· {getCurrentUserName()}</span>
        </label>
      )}

      {onlyMe ? (
        // Our own tooltip rather than a native `title`, which waits ~half a second before showing
        // and cannot be made faster. It follows the pointer and renders at full strength.
        <div
          aria-disabled
          className="vf-disabled"
          onMouseMove={(e) => setTipAt({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setTipAt(null)}
        >
          <div className="opacity-50">{body}</div>
          {tipAt && <CursorTooltip text={ONLY_ME_TIP} at={tipAt} />}
        </div>
      ) : body}

      {showSettings && (
        <ViewFilterSettings
          rule={rule}
          flat={flat}
          options={allOptions}
          anchorRef={settingsBtnRef}
          onChange={onChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

function ViewFilterPane({
  rules, baseRules, dragging, source, fields, aggregations, rangeConfigs, onDrop, onRemove, onRuleChange, reportMode, flat,
}: {
  rules: FilterRule[]
  baseRules: FilterRule[]
  dragging: boolean
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  onDrop: (name: string, type: FieldType) => void
  onRemove: (field: string) => void
  onRuleChange: (field: string, patch: Partial<FilterRule>) => void
  reportMode: ReportMode
  // Tabular reports have no pivot groups — numeric cards slide over record values, and the
  // aggregate-function setting is hidden. See ViewFilterCard.
  flat?: boolean
}) {
  const [over, setOver] = useState(false)
  const refusal = useFormulaDropRefusal(flat)
  const isCreate = reportMode === "create"

  // A viewer with no exposed filters gets no pane at all — an empty rail is pure noise. In
  // create mode it always renders, since it has to be there to drop onto.
  if (!isCreate && rules.length === 0) return null

  const handleDragOver = (e: React.DragEvent) => { if (refusal.refuse(e)) return; e.preventDefault(); setOver(true) }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) { setOver(false); refusal.clear() }
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/field")) as { field: string; type: FieldType }
      if (isFormulaKey(data.field)) return
      onDrop(data.field, data.type)
    } catch {}
  }

  const highlight = isCreate && !refusal.blocked && (over || (dragging && rules.length === 0 && !(activeDrag && isFormulaKey(activeDrag.field))))
  // Grain must account for every rule the report actually applies, but the value list itself is
  // narrowed by the BASE rules only — stable, and no cascade between sibling view filters.
  const grainRules = baseRules.length > 0 ? [...baseRules, ...rules] : rules

  return (
    <aside
      onDragOver={isCreate ? handleDragOver : undefined}
      onDragLeave={isCreate ? handleDragLeave : undefined}
      onDrop={isCreate ? handleDrop : undefined}
      className={isCreate
        // While building it is one of the stacked sections in the Build panel.
        ? `w-full rounded-lg flex flex-col transition-colors ${refusal.blocked ? "border-2 border-dashed border-gray-300 bg-gray-100 opacity-60 cursor-not-allowed"
            : highlight ? "border-2 border-dashed border-amber-300 bg-amber-50"
            : rules.length === 0 ? "border-2 border-dashed border-gray-200 bg-gray-50/60" : "border border-gray-200 bg-gray-50/60 shadow-sm"}`
        : `w-[280px] shrink-0 flex flex-col border-l border-gray-200 overflow-hidden transition-colors bg-white`}
    >
      {refusal.tip}
      {/* Builder-only heading: it names the drop target and counts what's in it. A viewer just
          sees filter cards, so the label is noise — each card already names its own field. */}
      {isCreate && (
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 shrink-0">
          <span className={`text-[11px] font-bold uppercase tracking-wider transition-colors
            ${highlight ? "text-amber-500" : "text-gray-600"}`}>
            View filters
          </span>
          {rules.length > 0 && (
            <span className="text-[10px] bg-gray-200/70 text-gray-600 rounded-full px-1.5 py-px font-medium">
              {rules.length}
            </span>
          )}
        </div>
      )}

      <div className={isCreate ? "px-3 pb-2.5 flex flex-col gap-1.5 items-stretch" : "flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-3.5 flex flex-col gap-1.5 items-start"}>
        {rules.length === 0 ? (
          <>
            <span className={`text-[12px] leading-relaxed transition-colors ${highlight ? "text-amber-500" : "text-gray-400"}`}>
              {highlight ? "Release to add" : "Drop a field here to let viewers filter this report."}
            </span>
            <span className="text-[11px] text-gray-300 leading-relaxed mt-1">
              Applied after the report's own Filters.
            </span>
          </>
        ) : (
          rules.map((rule) => (
            <ViewFilterCard
              key={rule.field}
              rule={rule}
              baseRules={baseRules}
              source={source}
              fields={fields}
              aggregations={aggregations}
              rangeConfigs={rangeConfigs}
              valueOptions={relevantFieldValues(source, fields, grainRules, baseRules, rule.field, rule.type, rule.lookupPath)}
              isCreate={isCreate}
              flat={flat}
              onRemove={() => onRemove(rule.field)}
              onChange={(patch) => onRuleChange(rule.field, patch)}
            />
          ))
        )}
      </div>
    </aside>
  )
}

// ── Tabular builder ────────────────────────────────────────────────────────────

// The tabular equivalent of DropZoneBar: two shelves instead of three. DropZone itself is
// reused unchanged — it is generic over its zone key and agnostic about what the chips mean.
function TabularZoneBar({
  source, fields, dragging, grainModule, lookupPaths, aggregations, rangeConfigs, fieldFormats,
  onDrop, onMove, onReorder, onRemove, onAggChange, onLookupPathChange, onRangeConfigChange, onFieldFormatChange, blockReason,
}: {
  blockReason?: (zone: TabularZoneKey, field: string, id?: string) => string | null
  source?: string
  fields: TabularFields
  dragging: boolean
  grainModule: string
  lookupPaths: Record<string, string>
  onLookupPathChange: (id: string, path: string) => void
  aggregations: Record<string, string>
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  onDrop: (zone: TabularZoneKey, field: string, type: FieldType) => void
  onMove: (from: TabularZoneKey, to: TabularZoneKey, id: string) => void
  onReorder: (zone: TabularZoneKey, id: string, toIndex: number) => void
  onRemove: (zone: TabularZoneKey, id: string) => void
  onAggChange: (id: string, agg: string) => void
  onRangeConfigChange: (id: string, cfg: RangeConfig) => void
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
}) {
  // Group by sits first because that's where its fields land in the table — leftmost. The shelf
  // order mirrors the column order, so the builder reads the same way the result does.
  const zones: { key: TabularZoneKey; label: string; chips: PivotItem[] }[] = [
    { key: "tabGroupBy", label: "Group by", chips: fields.groupBy },
    { key: "tabColumns", label: "Columns", chips: fields.columns },
  ]
  const noop = () => {}
  return (
    <div className="flex flex-col gap-2.5 print-hide">
      {zones.map(({ key, label, chips }) => (
        <DropZone
          key={key}
          zone={key}
          label={label}
          chips={chips}
          dragging={dragging}
          isSuggested={false}
          grainModule={grainModule}
          source={source}
          lookupPaths={lookupPaths}
          onLookupPathChange={onLookupPathChange}
          aggregations={aggregations}
          timelineFilters={{}}
          rangeConfigs={rangeConfigs}
          fieldFormats={fieldFormats}
          onDrop={onDrop}
          onMove={onMove}
          onReorder={onReorder}
          onRemove={onRemove}
          onAggChange={onAggChange}
          onTimelineChange={noop}
          onRangeConfigChange={onRangeConfigChange}
          onFieldFormatChange={onFieldFormatChange}
          blockReason={blockReason}
        />
      ))}
    </div>
  )
}

// The flat table. Structured to match ReportCanvas's wrappers exactly — data-print-root on the
// outer div, the scroll card as its only child, data-report-table on the table — so CSV export
// and the print stylesheet work with no extra wiring.
function TabularCanvas({
  source, fields, aggregations, filterRules, viewFilterRules, lookupPaths, rangeConfigs, fieldFormats,
  showModuleTag, showProjectCurrency, showRowNumbers, groupSortDir, onGroupSortToggle,
}: {
  source: string
  fields: TabularFields
  lookupPaths: Record<string, string>
  aggregations: Record<string, string>
  filterRules: FilterRule[]
  viewFilterRules: FilterRule[]
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  showModuleTag: boolean
  showProjectCurrency: boolean
  showRowNumbers: boolean
  groupSortDir: "asc" | "desc"
  onGroupSortToggle: () => void
}) {
  const hl = useHighlightStyle()
  const isEmpty = fields.columns.length === 0 && fields.groupBy.length === 0

  if (isEmpty) {
    return (
      <div data-print-root className="flex-1 min-w-0 min-h-0 overflow-hidden bg-gray-50 p-5 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center bg-white rounded-xl border border-gray-100 shadow-sm gap-4 select-none">
          <svg width="120" height="88" viewBox="0 0 120 88" fill="none" className="opacity-20">
            <rect x="1" y="1" width="118" height="86" rx="5" stroke="#6366f1" strokeWidth="2" strokeDasharray="6 4" />
            <line x1="1" y1="22" x2="119" y2="22" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="4 3" />
            <line x1="34" y1="1" x2="34" y2="87" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="4 3" />
            <rect x="8" y="8" width="20" height="8" rx="2" fill="#6366f1" opacity="0.4" />
            <rect x="42" y="8" width="26" height="8" rx="2" fill="#6366f1" opacity="0.3" />
            <rect x="78" y="8" width="30" height="8" rx="2" fill="#6366f1" opacity="0.3" />
            <rect x="42" y="32" width="24" height="6" rx="2" fill="#6366f1" opacity="0.2" />
            <rect x="78" y="32" width="28" height="6" rx="2" fill="#6366f1" opacity="0.2" />
            <rect x="42" y="48" width="20" height="6" rx="2" fill="#6366f1" opacity="0.18" />
            <rect x="78" y="48" width="26" height="6" rx="2" fill="#6366f1" opacity="0.18" />
            <rect x="42" y="64" width="26" height="6" rx="2" fill="#6366f1" opacity="0.15" />
            <rect x="78" y="64" width="22" height="6" rx="2" fill="#6366f1" opacity="0.15" />
          </svg>
          <div className="text-center">
            <p className="text-[15px] font-semibold text-gray-700 mb-1">Nothing to show yet</p>
            <p className="text-[13px] text-gray-400 max-w-[280px] leading-relaxed">
              Drag fields from the left panel into <strong className="text-gray-500 font-medium">Columns</strong> to
              list records, or into <strong className="text-gray-500 font-medium">Group by</strong> to group them
            </p>
          </div>
        </div>
      </div>
    )
  }

  const report = computeTabularData(
    source, fields, aggregations, filterRules, viewFilterRules, rangeConfigs, fieldFormats,
    groupSortDir, showProjectCurrency, lookupPaths,
  )
  const { rows, totalCount, grainModule } = report

  const thCls = "border-b border-r border-gray-200 px-4 py-2.5 text-[12px] font-semibold text-left whitespace-nowrap sticky top-0 z-10 bg-gray-50"
  const tdCls = "border-b border-r border-gray-100 px-4 py-2 text-[13px] whitespace-nowrap"

  const headerCell = (item: PivotItem, group: boolean) => {
    const type = getFieldType(item.field)
    const align = alignClass(fieldFormats[item.id], !group && isNumericType(type) ? "right" : "left")
    return (
      <th key={item.id} className={`${thCls} ${align} ${group ? "text-gray-800" : "text-gray-600"} min-w-[140px]`}>
        <span className="inline-flex items-center gap-1.5">
          {fieldTypeIcon(type, 11)}
          <span>{fieldItemLabel(item, fieldFormats)}</span>
          <ModuleTag field={item.field} show={showModuleTag} />
          {!group && <HighlightHeaderMark field={item.field} />}
          {group && (
            <button
              onClick={onGroupSortToggle}
              title={groupSortDir === "asc" ? "Sorted A→Z — click to reverse" : "Sorted Z→A — click to reverse"}
              className="text-gray-400 hover:text-indigo-600 transition-colors ml-0.5"
            >
              <span style={{ display: "inline-block", transform: groupSortDir === "desc" ? "rotate(180deg)" : "none" }}>
                <Ic.ChevDown size={11} />
              </span>
            </button>
          )}
        </span>
      </th>
    )
  }

  // How many consecutive rows share this row's group prefix — drives the rowSpan that makes a
  // group's label render once and span its records, the arrangement the reference tool uses.
  const spanAt = (ri: number, level: number): number => {
    const key = rows[ri].groupLabels.slice(0, level + 1).join("␟")
    let n = 1
    while (ri + n < rows.length && rows[ri + n].groupLabels.slice(0, level + 1).join("␟") === key) n++
    return n
  }
  const startsGroup = (ri: number, level: number): boolean =>
    ri === 0 || rows[ri - 1].groupLabels.slice(0, level + 1).join("␟") !== rows[ri].groupLabels.slice(0, level + 1).join("␟")

  return (
    <div data-print-root className="flex-1 min-w-0 min-h-0 overflow-hidden bg-gray-50 p-5 flex flex-col items-start gap-2">
      <div className="flex-1 min-h-0 w-fit max-w-full overflow-auto bg-white rounded-xl border border-gray-100 shadow-sm">
        <table data-report-table className="border-collapse text-[13px]">
          <thead>
            <tr>
              {showRowNumbers && <th className={`${thCls} text-gray-400 w-12 text-right`}>#</th>}
              {fields.groupBy.map((item) => headerCell(item, true))}
              {fields.columns.map((item) => headerCell(item, false))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  className={`${tdCls} text-gray-400 italic`}
                  colSpan={(showRowNumbers ? 1 : 0) + fields.groupBy.length + fields.columns.length}
                >
                  No records match the current filters.
                </td>
              </tr>
            ) : rows.map((row, ri) => (
              <tr key={ri} className="hover:bg-indigo-50/30 transition-colors">
                {showRowNumbers && (
                  <td className={`${tdCls} text-gray-400 text-right tabular-nums`}>{ri + 1}</td>
                )}
                {fields.groupBy.map((item, gi) =>
                  startsGroup(ri, gi) ? (
                    <td
                      key={item.id}
                      rowSpan={spanAt(ri, gi)}
                      className={`${tdCls} text-gray-800 font-semibold align-top pt-2.5 border-t-2 border-t-gray-200 ${alignClass(fieldFormats[item.id], "left")}`}
                    >
                      {row.groupLabels[gi]}
                    </td>
                  ) : null,
                )}
                {row.cells.map((cell, ci) => {
                  const item = fields.columns[ci]
                  const type = getFieldType(item.field)
                  const rawNum = typeof cell.raw === "number" && Number.isFinite(cell.raw) ? cell.raw : null
                  return (
                    <td
                      key={item.id}
                      data-v={rawNum ?? undefined}
                      style={rawNum != null && isNumericType(type) ? hl(item.field, rawNum) : undefined}
                      className={`${tdCls} text-gray-700 ${alignClass(fieldFormats[item.id], isNumericType(type) ? "right" : "left")} ${isNumericType(type) ? "tabular-nums" : ""}`}
                    >
                      {cell.text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalCount > rows.length && (
        <p className="text-[11px] text-gray-400 shrink-0">
          Showing {rows.length.toLocaleString()} of {totalCount.toLocaleString()} records from {grainModule}.
        </p>
      )}
    </div>
  )
}


// Source picker + settings gear. A deliberate sibling of Toolbar rather than a set of optional
// props on it: the pivot toolbar is threaded with reportView, the Detail/Compact toggle and
// totals — none of which a flat table has — so keeping them apart leaves the pivot path untouched.
function TabularToolbar({
  source, setSource, reportMode, viewBar,
  showModuleTag, onShowModuleTagChange, showProjectCurrency, onShowProjectCurrencyChange,
  showRowNumbers, onShowRowNumbersChange, fields, fieldFormats, onFieldFormatChange,
}: {
  source: string; setSource: (s: string) => void
  reportMode: ReportMode
  /** The saved-views controls, which take over this bar's left side in view mode. */
  viewBar: React.ReactNode
  showModuleTag: boolean; onShowModuleTagChange: (v: boolean) => void
  showProjectCurrency: boolean; onShowProjectCurrencyChange: (v: boolean) => void
  showRowNumbers: boolean; onShowRowNumbersChange: (v: boolean) => void
  fields: TabularFields
  fieldFormats: Record<string, FieldFormat>
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
}) {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <div className="flex items-center gap-3 px-5 py-2 border-b border-gray-200 bg-white text-[13px] print-hide">
      {reportMode === "view" && viewBar}
      {reportMode === "create" && <SourcePicker source={source} setSource={setSource} />}

      <div className="flex items-center gap-1 ml-auto">
        {reportMode === "create" && <HighlightToolbarButton />}
        <button
          title="Report settings"
          onClick={() => setShowSettings(true)}
          className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors
            ${showSettings ? "bg-indigo-100 text-indigo-600" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"}`}
        >
          <Ic.Gear size={15} />
        </button>
      </div>

      {showSettings && (
        <TabularSettingsPanel
          fields={fields}
          showModuleTag={showModuleTag}
          onShowModuleTagChange={onShowModuleTagChange}
          showProjectCurrency={showProjectCurrency}
          onShowProjectCurrencyChange={onShowProjectCurrencyChange}
          showRowNumbers={showRowNumbers}
          onShowRowNumbersChange={onShowRowNumbersChange}
          fieldFormats={fieldFormats}
          onFieldFormatChange={onFieldFormatChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

// Same right-hand drawer as ReportSettingsPanel, minus the settings a flat table has no use for:
// no Layout (Detail/Compact is a pivot idea) and no Totals (nothing is aggregated).
function TabularSettingsPanel({
  fields, showModuleTag, onShowModuleTagChange, showProjectCurrency, onShowProjectCurrencyChange,
  showRowNumbers, onShowRowNumbersChange, fieldFormats, onFieldFormatChange, onClose,
}: {
  fields: TabularFields
  showModuleTag: boolean; onShowModuleTagChange: (v: boolean) => void
  showProjectCurrency: boolean; onShowProjectCurrencyChange: (v: boolean) => void
  showRowNumbers: boolean; onShowRowNumbersChange: (v: boolean) => void
  fieldFormats: Record<string, FieldFormat>
  onFieldFormatChange: (id: string, patch: Partial<FieldFormat>) => void
  onClose: () => void
}) {
  const formatItems: { item: PivotItem; zone: string }[] = [
    ...fields.groupBy.map((item) => ({ item, zone: "Group by" })),
    ...fields.columns.map((item) => ({ item, zone: "Column" })),
  ]

  const toggle = (label: string, note: string, on: boolean, set: (v: boolean) => void) => (
    <div>
      <label className="flex items-center justify-between cursor-pointer select-none py-1">
        <span className="text-[13px] text-gray-700">{label}</span>
        <span
          onClick={() => set(!on)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0
            ${on ? "bg-indigo-600" : "bg-gray-200"}`}
        >
          <span className={`inline-block w-3.5 h-3.5 transform rounded-full bg-white transition-transform
            ${on ? "translate-x-[18px]" : "translate-x-1"}`} />
        </span>
      </label>
      {note && <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{note}</p>}
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative bg-white w-96 h-full shadow-2xl flex flex-col animate-panel-in">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 shrink-0">
          <Ic.Gear size={16} />
          <span className="text-[15px] font-semibold text-gray-900">Table settings</span>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-700 transition-colors p-1 rounded-lg hover:bg-gray-100">
            <Ic.X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Rows</p>
            {toggle("Show row numbers", "", showRowNumbers, onShowRowNumbersChange)}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Headers</p>
            {toggle(
              "Show source module in headers",
              "Tags each header with its owning module — helps tell apart same-named fields from different modules.",
              showModuleTag, onShowModuleTagChange,
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Currency</p>
            {toggle(
              "View table values in project's currency",
              "Tags each money value with its own record's project currency.",
              showProjectCurrency, onShowProjectCurrencyChange,
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Formatting</p>
            {formatItems.length === 0 ? (
              <p className="text-[12px] text-gray-400 leading-relaxed">
                Drop a field into Columns or Group by to format it here.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {formatItems.map(({ item, zone }) => (
                  <FieldFormatListItem
                    key={item.id}
                    item={item}
                    zone={zone}
                    format={fieldFormats[item.id] ?? DEFAULT_FIELD_FORMAT}
                    onChange={(patch) => onFieldFormatChange(item.id, patch)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

const SAVED_TABULAR_KEY = "customReportsV2.savedTabular"
const SAVED_TABULAR_VIEWS_KEY = "customReportsV2.savedTabularViews"

interface SavedTabularReport {
  source: string
  fields: TabularFields
  aggregations: Record<string, string>
  filterRules: FilterRule[]
  viewFilterRules: FilterRule[]
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  showModuleTag: boolean
  showProjectCurrency: boolean
  showRowNumbers: boolean
  groupSortDir: "asc" | "desc"
  lookupPaths: Record<string, string>
  highlightRules?: HighlightRule[]
}

function loadSavedTabular(): Partial<SavedTabularReport> | null {
  try {
    const raw = localStorage.getItem(SAVED_TABULAR_KEY)
    const parsed: Partial<SavedTabularReport> | null = raw ? migrateFieldKeys(JSON.parse(raw)) : null
    if (parsed?.fields) {
      reserveItemIds([...(parsed.fields.columns ?? []), ...(parsed.fields.groupBy ?? [])])
    }
    return parsed
  } catch {
    return null
  }
}

// The tabular report is its own entity — separate source, fields, filters and saved payload from
// the pivot builder, with no switching between them. It owns all of that state here rather than
// in App(), which keeps the two report types genuinely independent.
function TabularBuilder() {
  const [saved] = useState(() => loadSavedTabular())

  const [reportMode, setReportMode] = useState<ReportMode>("create")
  const [source, setSource] = useState<string>(saved?.source ?? "Project")
  const [fields, setFields] = useState<TabularFields>(saved?.fields ?? { columns: [], groupBy: [] })
  const [aggregations, setAggregations] = useState<Record<string, string>>(saved?.aggregations ?? {})
  const [filterRules, setFilterRules] = useState<FilterRule[]>(saved?.filterRules ?? [])
  const [viewFilterRules, setViewFilterRules] = useState<FilterRule[]>(saved?.viewFilterRules ?? [])
  const [rangeConfigs, setRangeConfigs] = useState<Record<string, RangeConfig>>(saved?.rangeConfigs ?? {})
  const [lookupPaths, setLookupPaths] = useState<Record<string, string>>(saved?.lookupPaths ?? {})
  const [fieldFormats, setFieldFormats] = useState<Record<string, FieldFormat>>(saved?.fieldFormats ?? {})
  const [showModuleTag, setShowModuleTag] = useState(saved?.showModuleTag ?? false)
  const [showProjectCurrency, setShowProjectCurrency] = useState(saved?.showProjectCurrency ?? false)
  const [showRowNumbers, setShowRowNumbers] = useState(saved?.showRowNumbers ?? true)
  const [groupSortDir, setGroupSortDir] = useState<"asc" | "desc">(saved?.groupSortDir ?? "asc")
  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(saved?.highlightRules ?? [])
  useFormulas()
  const columnNumberKeys = [...new Set(fields.columns.map((v) => v.field).filter((k) => isNumericType(getFieldType(k)) && (!isFormulaKey(k) || !!formulaOf(k))))]
  const columnKeysSig = columnNumberKeys.join("|")
  useEffect(() => {
    setHighlightRules((prev) => {
      const next = prev.filter((r) => columnNumberKeys.includes(r.fieldName))
      return next.length === prev.length ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKeysSig])

  const [dragging, setDragging] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [dupAlert, setDupAlert] = useState<string | null>(null)
  const [needsFieldAlert, setNeedsFieldAlert] = useState(false)
  const [justDroppedFilter, setJustDroppedFilter] = useState<string | null>(null)
  const [pendingSource, setPendingSource] = useState<string | null>(null)

  const pivotShape = asPivotFields(fields)
  const hasAnyField = fields.columns.length > 0 || fields.groupBy.length > 0
  // Chips need the grain to know which of their relationships are ambiguous from here.
  const grainModule = pickGrain(source, pivotShape, filterRules)

  // Serialising the whole payload is how "has anything changed?" is answered — cheaper to keep
  // honest than a dirty flag threaded through every one of the builder's ~20 setters, and it can
  // never drift out of sync with what Save actually writes.
  const payloadJson = JSON.stringify({
    source, fields, aggregations, filterRules, viewFilterRules, rangeConfigs, fieldFormats,
    showModuleTag, showProjectCurrency, showRowNumbers, groupSortDir, lookupPaths, highlightRules,
  } satisfies SavedTabularReport)
  // A restored report starts clean; one that has never been saved starts dirty. This initialiser
  // runs on the first render, where payloadJson is built from exactly the restored state.
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(saved ? payloadJson : null)
  // An empty report has nothing worth saving, so it doesn't get the "unsaved changes" emphasis.
  const dirty = savedSnapshot !== payloadJson && hasAnyField

  const savedViews = useSavedViews(SAVED_TABULAR_VIEWS_KEY, reportMode, viewFilterRules, setViewFilterRules)
  const [showNewView, setShowNewView] = useState(false)

  // Nothing dropped means nothing to write — saving an empty report would only overwrite a real
  // one already in storage with a blank payload.
  const saveBlockedReason = hasAnyField
    ? null
    : "Add fields to Columns or Group by before saving this report"

  // View mode shows a finished report, so it needs one that exists and is saved.
  const viewBlockedReason = !hasAnyField
    ? "Add fields to Columns or Group by before viewing this report"
    : dirty
      ? "Save your changes to view this report"
      : null

  const handleSave = () => {
    if (saveBlockedReason !== null) return
    try {
      localStorage.setItem(SAVED_TABULAR_KEY, payloadJson)
      setSavedSnapshot(payloadJson)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1500)
    } catch {}
  }

  // FieldBrowser speaks PivotZoneKey; map its zones onto the two tabular shelves. "rows" is what
  // it uses for non-numeric click-to-add, so that becomes Group by; everything else is a Column.
  const [usedAlert, setUsedAlert] = useState<{ name: string; zone: string } | null>(null)

  const zoneOf = (z: PivotZoneKey): TabularZoneKey => (z === "rows" ? "tabGroupBy" : "tabColumns")
  const listKey = (z: TabularZoneKey) => (z === "tabGroupBy" ? "groupBy" : "columns") as keyof TabularFields

  const addField = (zone: TabularZoneKey, field: string, type: FieldType) => {
    // A flat list has one row per record, so there is nothing to split by period. The Timeline
    // still works here as a filter.
    if (field === TIMELINE_KEY) return
    // A formula is a number worked out per record — a column, never a group.
    if (isFormulaKey(field) && zone === "tabGroupBy") return
    // One appearance per field. Both shelves feed the same flat row, so a second copy would
    // repeat a value rather than add information — refuse and say where the first copy is.
    const inGroupBy = fields.groupBy.some((it) => it.field === field)
    const inColumns = fields.columns.some((it) => it.field === field)
    if (inGroupBy || inColumns) {
      setUsedAlert({ name: fieldDisplayName(field), zone: inGroupBy ? "Group by" : "Columns" })
      return
    }
    const id = nextPivotItemId()
    const key = listKey(zone)
    setFields((prev) => ({ ...prev, [key]: [...prev[key], { id, field }] }))
    // Only a grouping field gets a modifier; a column shows its raw value.
    if (zone === "tabGroupBy") {
      let mod: string | undefined
      if (isNumericType(type)) mod = "Dimension"
      else if (type === "date") mod = "Quarter & Year"
      if (mod) setAggregations((prev) => ({ ...prev, [id]: mod! }))
    }
  }
  const removeField = (zone: TabularZoneKey, id: string) => {
    const key = listKey(zone)
    setFields((prev) => ({ ...prev, [key]: prev[key].filter((it) => it.id !== id) }))
  }
  const reorderField = (zone: TabularZoneKey, id: string, toIndex: number) => {
    const key = listKey(zone)
    setFields((prev) => {
      const item = prev[key].find((it) => it.id === id)
      if (!item) return prev
      const arr = prev[key].filter((it) => it.id !== id)
      arr.splice(toIndex, 0, item)
      return { ...prev, [key]: arr }
    })
  }
  const moveField = (from: TabularZoneKey, to: TabularZoneKey, id: string) => {
    const fk = listKey(from), tk = listKey(to)
    if (to === "tabGroupBy" && fields[fk].some((it) => it.id === id && isFormulaKey(it.field))) return
    setFields((prev) => {
      const item = prev[fk].find((it) => it.id === id)
      if (!item) return prev
      return { ...prev, [fk]: prev[fk].filter((it) => it.id !== id), [tk]: [...prev[tk], item] }
    })
  }

  const makeRule = (name: string, type: FieldType) => makeFilterRule(name, type)

  // In a flat list the Timeline is a filter on time-tracked fields, so it needs one first.
  const timelineBlocked = timelineMetricItems(pivotShape).length > 0 ? null : "Add a time-tracked metric first"

  const handleFilterDrop = (name: string, type: FieldType) => {
    if (name === TIMELINE_KEY && timelineBlocked) return
    if (!hasAnyField) { setNeedsFieldAlert(true); return }
    setFilterRules((prev) => (prev.find((r) => r.field === name) ? prev : [...prev, makeRule(name, type)]))
    setJustDroppedFilter(name)
  }
  const handleViewFilterDrop = (name: string, type: FieldType) => {
    if (name === TIMELINE_KEY && timelineBlocked) return
    if (!hasAnyField) { setNeedsFieldAlert(true); return }
    setViewFilterRules((prev) => {
      if (prev.find((r) => r.field === name)) return prev
      const rule = makeRule(name, type)
      return [...prev, isNumericType(type) ? { ...rule, numMode: "range" as const } : rule]
    })
    setJustDroppedFilter(name)
  }

  const requestSourceChange = (next: string) => {
    if (next === source) return
    const empty = !hasAnyField && filterRules.length === 0 && viewFilterRules.length === 0
    if (empty) { setSource(next); return }
    setPendingSource(next)
  }
  const confirmSourceChange = () => {
    if (!pendingSource) return
    setSource(pendingSource)
    setFields({ columns: [], groupBy: [] })
    setAggregations({})
    setFilterRules([])
    setViewFilterRules([])
    setRangeConfigs({})
    setFieldFormats({})
    setHighlightRules([])
    setPendingSource(null)
  }

  return (
    <ReportExtrasHost
      source={source}
      formulaZone="tabColumns"
      targets={columnNumberKeys.map((k) => ({ field: k, label: fieldDisplayName(k) }))}
      highlightRules={highlightRules}
      onHighlightRulesChange={setHighlightRules}
      onFormulaCreated={(key) => addField("tabColumns", key, "number")}
      onFormulaDeleted={(key) => {
        setFields((prev) => ({ ...prev, columns: prev.columns.filter((v) => v.field !== key) }))
        setHighlightRules((prev) => prev.filter((r) => r.fieldName !== key))
      }}
    >
      {usedAlert && (
        <FieldAlreadyUsedAlert name={usedAlert.name} zone={usedAlert.zone} onClose={() => setUsedAlert(null)} />
      )}
      {showNewView && (
        <NewViewModal
          existingNames={savedViews.views.map((v) => v.name)}
          onSave={(name, audience, members) => { savedViews.saveView(name, audience, members); setShowNewView(false) }}
          onClose={() => setShowNewView(false)}
        />
      )}
      {dupAlert && (
        <DupFieldAlert
          name={fieldDisplayName(dupAlert)}
          count={[...fields.columns, ...fields.groupBy].filter((it) => it.field === dupAlert).length}
          onClose={() => setDupAlert(null)}
        />
      )}
      {needsFieldAlert && <FilterNeedsFieldAlert onClose={() => setNeedsFieldAlert(false)} />}
      {pendingSource && (
        <SourceChangeConfirmModal
          nextSource={pendingSource}
          onConfirm={confirmSourceChange}
          onCancel={() => setPendingSource(null)}
        />
      )}

      <PageHeader
        reportMode={reportMode} onReportModeChange={setReportMode} onSave={handleSave}
        justSaved={justSaved} dirty={dirty}
        saveBlockedReason={saveBlockedReason} viewBlockedReason={viewBlockedReason}
      />
      <TabularToolbar
        source={source}
        setSource={requestSourceChange}
        reportMode={reportMode}
        viewBar={
          <SavedViewsBar
            views={savedViews.views}
            activeId={savedViews.activeId}
            activeName={savedViews.activeName}
            dirty={savedViews.dirty}
            onPick={savedViews.applyView}
            onSaveAs={() => setShowNewView(true)}
            onReset={savedViews.resetView}
            onDelete={savedViews.deleteView}
          />
        }
        showModuleTag={showModuleTag}
        onShowModuleTagChange={setShowModuleTag}
        showProjectCurrency={showProjectCurrency}
        onShowProjectCurrencyChange={setShowProjectCurrency}
        showRowNumbers={showRowNumbers}
        onShowRowNumbersChange={setShowRowNumbers}
        fields={fields}
        fieldFormats={fieldFormats}
        onFieldFormatChange={(id, patch) =>
          setFieldFormats((prev) => ({ ...prev, [id]: { ...DEFAULT_FIELD_FORMAT, ...prev[id], ...patch } }))}
      />

      <div className="flex flex-1 overflow-hidden">
        {reportMode === "create" && (
          <FieldBrowser
            fields={pivotShape}
            source={source}
            timelineBlocked={timelineBlocked}
            onAdd={(zone, field, type) => addField(zoneOf(zone), field, type)}
            onRemove={(zone, id) => removeField(zoneOf(zone), id)}
            onDupAlert={(name) => setDupAlert(name)}
            onDragStart={(field) => { startDrag(field); setDragging(true) }}
            onDragEnd={() => { endDrag(); setDragging(false) }}
          />
        )}
        {reportMode === "create" && (
          <BuildPanel>
            <TabularZoneBar
              source={source}
              fields={fields}
              dragging={dragging}
              grainModule={grainModule}
              lookupPaths={lookupPaths}
              onLookupPathChange={(id, path) => setLookupPaths((prev) => ({ ...prev, [id]: path }))}
              aggregations={aggregations}
              rangeConfigs={rangeConfigs}
              fieldFormats={fieldFormats}
              onDrop={addField}
              onMove={moveField}
              onReorder={reorderField}
              onRemove={removeField}
              onAggChange={(id, agg) => setAggregations((prev) => ({ ...prev, [id]: agg }))}
              onRangeConfigChange={(id, cfg) => setRangeConfigs((prev) => ({ ...prev, [id]: cfg }))}
              onFieldFormatChange={(id, patch) =>
                setFieldFormats((prev) => ({ ...prev, [id]: { ...DEFAULT_FIELD_FORMAT, ...prev[id], ...patch } }))}
              blockReason={(zone, field) => (isFormulaKey(field) && zone === "tabGroupBy" ? "Formula fields can only go in Columns" : null)}
            />
            <FilterBar
              rules={filterRules}
              dragging={dragging}
              source={source}
              fields={pivotShape}
              aggregations={aggregations}
              rangeConfigs={rangeConfigs}
              onDrop={handleFilterDrop}
              onRemove={(field) => setFilterRules((prev) => prev.filter((r) => r.field !== field))}
              onRuleChange={(field, patch) =>
                setFilterRules((prev) => prev.map((r) => (r.field === field ? { ...r, ...patch } : r)))}
              justDropped={justDroppedFilter}
              flat
            />
            <ViewFilterPane
              rules={viewFilterRules}
              baseRules={filterRules}
              dragging={dragging}
              source={source}
              fields={pivotShape}
              aggregations={aggregations}
              rangeConfigs={rangeConfigs}
              onDrop={handleViewFilterDrop}
              onRemove={(field) => setViewFilterRules((prev) => prev.filter((r) => r.field !== field))}
              onRuleChange={(field, patch) =>
                setViewFilterRules((prev) => prev.map((r) => (r.field === field ? { ...r, ...patch } : r)))}
              reportMode={reportMode}
              flat
            />
          </BuildPanel>
        )}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex flex-1 overflow-hidden">
            <TabularCanvas
              source={source}
              fields={fields}
              lookupPaths={lookupPaths}
              aggregations={aggregations}
              filterRules={filterRules}
              viewFilterRules={viewFilterRules}
              rangeConfigs={rangeConfigs}
              fieldFormats={fieldFormats}
              showModuleTag={showModuleTag}
              showProjectCurrency={showProjectCurrency}
              showRowNumbers={showRowNumbers}
              groupSortDir={groupSortDir}
              onGroupSortToggle={() => setGroupSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            />
            {reportMode === "view" && (
              <ViewFilterPane
                rules={viewFilterRules}
                baseRules={filterRules}
                dragging={dragging}
                source={source}
                fields={pivotShape}
                aggregations={aggregations}
                rangeConfigs={rangeConfigs}
                onDrop={handleViewFilterDrop}
                onRemove={(field) => setViewFilterRules((prev) => prev.filter((r) => r.field !== field))}
                onRuleChange={(field, patch) =>
                  setViewFilterRules((prev) => prev.map((r) => (r.field === field ? { ...r, ...patch } : r)))}
                reportMode={reportMode}
                flat
              />
            )}
          </div>
        </div>
      </div>
    </ReportExtrasHost>
  )
}


// ── Dashboard view ─────────────────────────────────────────────────────────────

function BarChart({ title, legend, bars, xLabels, maxVal }: {
  title: string
  legend: { label: string; color: string }[]
  bars: { values: number[]; label: string }[]
  xLabels: string[]
  maxVal: number
}) {
  const chartH = 110
  const barW = 14
  const groupGap = 22
  const chartW = bars.length * (legend.length * barW + groupGap) + 20

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col gap-3 flex-1 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-gray-800">{title}</span>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {legend.map(l => (
          <div key={l.label} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: l.color }} />
            <span className="text-[11px] text-gray-500">{l.label}</span>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <svg width={chartW} height={chartH + 24} className="overflow-visible">
          {/* Y gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map(t => (
            <line key={t} x1={0} x2={chartW} y1={chartH - t * chartH} y2={chartH - t * chartH}
              stroke="#f3f4f6" strokeWidth="1" />
          ))}
          {/* Bars */}
          {bars.map((group, gi) => {
            const gx = gi * (legend.length * barW + groupGap) + 10
            return group.values.map((v, vi) => {
              const h = Math.max(2, (v / maxVal) * chartH)
              return (
                <rect key={vi} x={gx + vi * barW} y={chartH - h} width={barW - 2} height={h}
                  fill={legend[vi]?.color ?? "#6366f1"} rx="2" />
              )
            })
          })}
          {/* X axis */}
          <line x1={0} x2={chartW} y1={chartH} y2={chartH} stroke="#e5e7eb" strokeWidth="1" />
          {/* X labels */}
          {xLabels.map((lbl, i) => {
            const gx = i * (legend.length * barW + groupGap) + 10 + (legend.length * barW) / 2
            return (
              <text key={i} x={gx} y={chartH + 16} textAnchor="middle"
                fontSize="9" fill="#9ca3af" fontFamily="Inter, sans-serif">
                {lbl}
              </text>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ── Timeline filter ────────────────────────────────────────────────────────────

const DASH_FILTER_RELATIVE = ["is more than...", "is exactly...", "is less than..."]
const DASH_FILTER_ABSOLUTE = ["is after...", "is on...", "is before..."]

const DATE_PRESETS = [
  "This week", "Last week", "This month", "Last month",
  "This quarter", "Last quarter", "Last 90 days",
  "This year", "Year to date", "Last 12 months",
]

// Minimal calendar helpers
function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}
function firstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"]

function CalendarMonth({ year, month, from, to, onDay }: {
  year: number; month: number
  from: string; to: string
  onDay: (iso: string) => void
}) {
  const days = daysInMonth(year, month)
  const startDay = firstDayOfMonth(year, month)
  const cells: (number | null)[] = [...Array(startDay).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]

  const isoOf = (d: number) => `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`

  return (
    <div className="w-[200px]">
      <p className="text-[13px] font-semibold text-gray-800 text-center mb-2">{MONTH_NAMES[month]} {year}</p>
      <div className="grid grid-cols-7 gap-0">
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
          <span key={d} className="text-[10px] text-gray-400 text-center py-1 font-medium">{d}</span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />
          const iso = isoOf(d)
          const isFrom = iso === from
          const isTo = iso === to
          const inRange = from && to && iso >= from && iso <= to
          return (
            <button key={i} onClick={() => onDay(iso)}
              className={`text-[12px] h-7 w-full rounded transition-colors
                ${isFrom || isTo ? "bg-indigo-600 text-white font-semibold" :
                  inRange ? "bg-indigo-100 text-indigo-700" :
                  "text-gray-700 hover:bg-gray-100"}`}
            >{d}</button>
          )
        })}
      </div>
    </div>
  )
}

// Per-metric date filter state
interface MetricFilter {
  period: string  // preset label or "custom"
  customFrom: string
  customTo: string
}

// Per-field bucketing config for a numeric Row/Column field in "Range" mode. "equal" splits
// the field's observed min–max span into fixed-size windows (bucketSize wide each — 0/unset
// means "compute a nice default from the span," see niceBucketSize). "custom" instead bands
// the field by user-chosen boundary edges — everything below the first edge, everything at/
// above the last edge, and one band between each adjacent pair.
interface RangeConfig {
  mode: "equal" | "custom"
  bucketSize: number
  customBounds: number[]
}

// Per-field display override for any PivotItem in Columns/Rows/Values — editable from the
// Report Settings panel's Formatting subsection AND from a matching gear icon on the field's
// own chip. Absent entry (or the default shape below) means "use the field's own default
// name/alignment/scaling" — zero behavior change until a user actually edits something for
// that field instance.
//
// units: "auto" (western tiered: B ≥1e9, M ≥1e6, K ≥1e3, else raw — today's fmtNum, extended
// to cover billions), "autoIN" (Indian tiered: C ≥1e7, L ≥1e5, K ≥1e3, else raw), or a single
// forced tier ("none"/"K"/"L"/"M"/"C"/"B") that always applies regardless of magnitude.
interface FieldFormat {
  displayName: string           // "" = use fieldDisplayName(item.field)
  align: "auto" | "left" | "center" | "right"  // "auto" = right for Values, left for Rows/Columns
  decimals: number | null       // null = auto (matches fmtNum's own rounding)
  // "auto" = Western tiered (K/M/B), "autoIN" = Indian tiered (K/L/C), "autoLocale" = picks
  // one of those two tiering systems based on the viewer's own OS/browser locale (see
  // detectIndianLocale) rather than a fixed choice — the third "auto" kind, distinct from
  // the other two which are both explicit, locale-independent tier choices.
  units: "auto" | "autoIN" | "autoLocale" | "none" | "K" | "L" | "M" | "C" | "B"
}
const DEFAULT_FIELD_FORMAT: FieldFormat = { displayName: "", align: "auto", decimals: null, units: "auto" }

function TimelineDropdown({
  filters,
  onChange,
  onClose,
}: {
  filters: Record<string, MetricFilter>
  onChange: (metric: string, f: MetricFilter | null) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState("")
  const [editingMetric, setEditingMetric] = useState<string | null>(null)
  const [calNav, setCalNav] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() - 1 })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])

  const query = search.toLowerCase()
  const visibleGroups = TIMELINE_GROUPS.map(g => ({
    ...g,
    metrics: g.metrics.filter(m => m.toLowerCase().includes(query)),
  })).filter(g => g.metrics.length > 0)

  const editing = editingMetric ? (filters[editingMetric] ?? { period: "Last 12 months", customFrom: "", customTo: "" }) : null
  const isCustom = editing?.period === "custom"

  const patchEditing = (patch: Partial<MetricFilter>) => {
    if (!editingMetric) return
    const current = filters[editingMetric] ?? { period: "Last 12 months", customFrom: "", customTo: "" }
    onChange(editingMetric, { ...current, ...patch })
  }

  const applyPreset = (preset: string) => {
    if (!editingMetric) return
    onChange(editingMetric, { period: preset, customFrom: "", customTo: "" })
  }

  const removeFilter = (metric: string) => {
    onChange(metric, null)
    if (editingMetric === metric) setEditingMetric(null)
  }

  return (
    <div ref={ref}
      className="absolute top-full left-0 mt-1.5 z-50 bg-white border border-gray-200 rounded-2xl shadow-2xl flex overflow-hidden"
      style={{ width: editingMetric ? 680 : 340, maxHeight: "70vh" }}
    >
      {/* ── Left: metric list ── */}
      <div className="w-[340px] shrink-0 flex flex-col overflow-hidden border-r border-gray-100">
        {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5 border-b border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-semibold text-gray-800">Timeline Filter</span>
            <span className="text-[11px] text-gray-400">{Object.keys(filters).length} of {ALL_TIMELINE_METRICS.length} fields</span>
          </div>
          <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-2.5 py-1.5">
            <Ic.Search />
            <input
              type="text"
              placeholder="Search metrics…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-[12px] text-gray-700 placeholder-gray-400 focus:outline-none"
            />
            {search && <button onClick={() => setSearch("")} className="text-gray-300 hover:text-gray-500"><Ic.X size={10} /></button>}
          </div>
        </div>

        {/* Groups */}
        <div className="overflow-y-auto flex-1 py-1">
          {visibleGroups.map(g => (
            <div key={g.group}>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 pt-3 pb-1">{g.group}</p>
              {g.metrics.map(metric => {
                const active = !!filters[metric]
                const isEditing = editingMetric === metric
                const f = filters[metric]
                const label = f
                  ? f.period === "custom" && f.customFrom && f.customTo
                    ? `${f.customFrom} → ${f.customTo}`
                    : f.period
                  : null
                return (
                  <div
                    key={metric}
                    className={`flex items-center gap-2.5 px-4 py-2 transition-colors cursor-pointer group
                      ${isEditing ? "bg-indigo-50" : active ? "hover:bg-indigo-50/60" : "hover:bg-gray-50"}`}
                    onClick={() => setEditingMetric(isEditing ? null : metric)}
                  >
                    <span className="text-emerald-500 shrink-0"><Ic.Hash size={12} /></span>
                    <span className={`text-[13px] flex-1 truncate ${isEditing ? "text-indigo-700 font-medium" : active ? "text-gray-800 font-medium" : "text-gray-700"}`}>
                      {metric}
                    </span>
                    {label && (
                      <span className="text-[11px] text-indigo-500 bg-indigo-50 border border-indigo-100 rounded px-1.5 py-0.5 font-medium shrink-0 max-w-[110px] truncate">
                        {label}
                      </span>
                    )}
                    {active ? (
                      <button
                        onClick={e => { e.stopPropagation(); removeFilter(metric) }}
                        className="shrink-0 text-gray-300 hover:text-red-400 transition-colors"
                      >
                        <Ic.X size={11} />
                      </button>
                    ) : (
                      <span className="shrink-0 text-gray-300 group-hover:text-indigo-400 transition-colors">
                        <Ic.Calendar size={12} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <p className="text-[13px] text-gray-400 text-center py-8">No matches</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={() => { ALL_TIMELINE_METRICS.forEach(m => onChange(m, null)); setEditingMetric(null) }}
            className="text-[12px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            Clear all
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-[12px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Done
          </button>
        </div>
      </div>

      {/* ── Right: date picker for selected metric ── */}
      {editingMetric && editing && (
        <div className="w-[340px] shrink-0 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 pt-3.5 pb-2.5 border-b border-gray-100 flex items-center gap-2">
            <span className="text-emerald-500"><Ic.Hash size={13} /></span>
            <span className="text-[13px] font-semibold text-gray-800 truncate flex-1">{editingMetric}</span>
            <button onClick={() => setEditingMetric(null)} className="text-gray-400 hover:text-gray-600 transition-colors">
              <Ic.X size={13} />
            </button>
          </div>

          {!isCustom ? (
            <div className="overflow-y-auto flex-1 py-2">
              {/* Presets */}
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-4 pt-1 pb-1">Presets</p>
              {DATE_PRESETS.map(p => (
                <button key={p}
                  onClick={() => applyPreset(p)}
                  className={`flex items-center justify-between w-full px-4 py-1.5 text-[13px] transition-colors
                    ${editing.period === p ? "bg-indigo-50 text-indigo-600 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                >
                  {p}
                  {editing.period === p && <Ic.Check />}
                </button>
              ))}

              {/* Relative */}
              <div className="my-1 border-t border-gray-100" />
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-4 pt-2 pb-1">Relative</p>
              {DASH_FILTER_RELATIVE.map(p => (
                <button key={p}
                  onClick={() => applyPreset(p)}
                  className={`flex items-center gap-2.5 w-full px-4 py-1.5 text-[13px] transition-colors
                    ${editing.period === p ? "bg-indigo-50 text-indigo-600" : "text-gray-700 hover:bg-gray-50"}`}
                >
                  <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0
                    ${editing.period === p ? "border-indigo-600" : "border-gray-300"}`}>
                    {editing.period === p && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
                  </span>
                  {p}
                </button>
              ))}

              {/* Absolute */}
              <div className="my-1 border-t border-gray-100" />
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-4 pt-2 pb-1">Absolute</p>
              {DASH_FILTER_ABSOLUTE.map(p => (
                <button key={p}
                  onClick={() => applyPreset(p)}
                  className={`flex items-center gap-2.5 w-full px-4 py-1.5 text-[13px] transition-colors
                    ${editing.period === p ? "bg-indigo-50 text-indigo-600" : "text-gray-700 hover:bg-gray-50"}`}
                >
                  <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0
                    ${editing.period === p ? "border-indigo-600" : "border-gray-300"}`}>
                    {editing.period === p && <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
                  </span>
                  {p}
                </button>
              ))}

              {/* Custom */}
              <div className="my-1 border-t border-gray-100" />
              <button
                onClick={() => patchEditing({ period: "custom" })}
                className="flex items-center justify-between w-full px-4 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Custom range <Ic.ChevRight size={12} />
              </button>
            </div>
          ) : (
            /* Custom calendar */
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">From</label>
                  <input type="date" value={editing.customFrom}
                    onChange={e => patchEditing({ customFrom: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400" />
                </div>
                <span className="text-gray-300 mt-4">→</span>
                <div className="flex-1">
                  <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1">To</label>
                  <input type="date" value={editing.customTo}
                    onChange={e => patchEditing({ customTo: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-700 focus:outline-none focus:border-indigo-400" />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button onClick={() => setCalNav(n => { const d = new Date(n.year, n.month - 1); return { year: d.getFullYear(), month: d.getMonth() } })}
                  className="p-1 rounded hover:bg-gray-100 text-gray-500 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button onClick={() => setCalNav(n => { const d = new Date(n.year, n.month + 2); return { year: d.getFullYear(), month: d.getMonth() } })}
                  className="p-1 rounded hover:bg-gray-100 text-gray-500 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>

              <CalendarMonth
                year={calNav.year} month={calNav.month}
                from={editing.customFrom} to={editing.customTo}
                onDay={iso => {
                  if (!editing.customFrom || (editing.customFrom && editing.customTo)) {
                    patchEditing({ customFrom: iso, customTo: "" })
                  } else {
                    if (iso < editing.customFrom) patchEditing({ customFrom: iso, customTo: editing.customFrom })
                    else patchEditing({ customTo: iso })
                  }
                }}
              />

              <button onClick={() => patchEditing({ period: "Last 12 months" })}
                className="text-[12px] text-gray-400 hover:text-gray-600 transition-colors text-left">
                ← Back to presets
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DashboardView() {
  const [showValues, setShowValues] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [timelineFilters, setTimelineFilters] = useState<Record<string, MetricFilter>>({})
  void showValues

  const handleTimelineChange = (metric: string, f: MetricFilter | null) => {
    setTimelineFilters(prev => {
      const next = { ...prev }
      if (f === null) delete next[metric]
      else next[metric] = f
      return next
    })
  }

  const activeCount = Object.keys(timelineFilters).length

  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden bg-gray-50 relative">
      {/* Dashboard header */}
      <div className="flex items-center gap-3 px-5 py-3.5 bg-white border-b border-gray-200">
        <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <h1 className="text-[18px] font-semibold text-gray-900">My First Dashboard</h1>
        <div className="ml-auto flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors">
            New dashboard <span className="text-gray-400">+</span>
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium">
            Add new widget <span className="opacity-60">+</span>
          </button>
        </div>
      </div>

      {/* Dashboard toolbar */}
      <div className="flex items-center gap-2 px-5 py-2 bg-white border-b border-gray-200 text-[13px]">
        <div className="flex items-center gap-1.5 border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span className="font-medium">Dashboard</span>
        </div>

        {/* Timeline Filter chip */}
        <div className="relative flex items-center gap-0">
          <button
            onClick={() => setShowTimeline(p => !p)}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors border text-[13px] font-medium
              ${activeCount > 0 ? "rounded-l-lg" : "rounded-lg"}
              ${showTimeline
                ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                : activeCount > 0
                  ? "bg-indigo-50 border-indigo-200 text-indigo-600 hover:border-indigo-300"
                  : "border-gray-200 text-gray-500 hover:text-gray-800 hover:bg-gray-50"}`}
          >
            <Ic.Calendar size={13} />
            <span>
              Timeline Filter:{" "}
              <span className={activeCount > 0 ? "text-indigo-700 font-semibold" : "text-gray-400 font-normal"}>
                {activeCount} fields
              </span>
            </span>
            <Ic.ChevDown size={11} />
          </button>
          {activeCount > 0 && (
            <button
              onClick={() => setTimelineFilters({})}
              className="border border-l-0 border-indigo-200 rounded-r-lg px-1.5 py-1.5 hover:bg-indigo-50 text-indigo-400 hover:text-indigo-600 transition-colors">
              <Ic.X size={12} />
            </button>
          )}

          {showTimeline && (
            <TimelineDropdown
              filters={timelineFilters}
              onChange={handleTimelineChange}
              onClose={() => setShowTimeline(false)}
            />
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-gray-500">Show values in charts</span>
            <button
              onClick={() => setShowValues(p => !p)}
              className={`relative w-9 h-5 rounded-full transition-colors ${showValues ? "bg-indigo-600" : "bg-gray-200"}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${showValues ? "translate-x-4" : "translate-x-0.5"}`} />
            </button>
          </label>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white rounded-lg text-[13px] font-medium hover:bg-gray-800 transition-colors">
            Share <Ic.ChevDown size={11} />
          </button>
        </div>
      </div>


      {/* Canvas */}
      <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">

        {/* KPI tile */}
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[13px] font-semibold text-gray-700">Projects In-Progress</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
              <polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>
            </svg>
          </div>
          <div className="flex items-center justify-center py-4">
            <span className="text-[72px] font-bold text-gray-900 leading-none">1</span>
          </div>
        </div>

        {/* 3 bar chart widgets */}
        <div className="flex gap-4">
          <BarChart
            title="Project by Status"
            legend={[{ label: "Proposed", color: "#60a5fa" }, { label: "In progress", color: "#34d399" }]}
            bars={[
              { label: "Proposed", values: [3, 0] },
              { label: "In progress", values: [0, 1] },
            ]}
            xLabels={["Proposed", "In progress"]}
            maxVal={3}
          />
          <BarChart
            title="Status by Phase"
            legend={[{ label: "Completed", color: "#34d399" }, { label: "In progress", color: "#60a5fa" }, { label: "+2 more", color: "#f87171" }]}
            bars={[
              { label: "Handoff", values: [1, 1, 0.5] },
              { label: "Inprogress", values: [0.5, 1, 1] },
              { label: "Migration", values: [1, 0.5, 0.8] },
            ]}
            xLabels={["Handoff...", "Inprogress", "Migration"]}
            maxVal={1.5}
          />
          <BarChart
            title="Task by status"
            legend={[{ label: "To do", color: "#60a5fa" }, { label: "Completed", color: "#34d399" }, { label: "Overdue", color: "#f87171" }]}
            bars={[
              { label: "To do", values: [15, 0, 0] },
              { label: "Completed", values: [0, 4, 0] },
              { label: "Overdue", values: [0, 0, 2] },
            ]}
            xLabels={["To do", "Completed", "Status"]}
            maxVal={20}
          />
        </div>

        {/* 2 placeholder cards */}
        <div className="flex gap-4">
          {["Projects Running late", "Projects Overdue"].map(title => (
            <div key={title} className="flex-1 bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm min-h-[120px]">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-gray-700">{title}</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
                  <polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>
                </svg>
              </div>
              <div className="flex items-center justify-center h-16 text-[12px] text-gray-300">No data</div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}

// ── Mock data helpers ──────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return (Math.round(n * 10) / 10).toLocaleString()
}

// Single-tier unit divisors/suffixes — shared by the explicit forced units and by the two
// tiered-auto modes below. L/C (Lakhs/Crores) are the Indian numbering system's equivalents
// of K/M/B.
const UNIT_TIER: Record<string, { divisor: number; suffix: string }> = {
  K: { divisor: 1_000, suffix: "K" },
  L: { divisor: 100_000, suffix: "L" },
  M: { divisor: 1_000_000, suffix: "M" },
  C: { divisor: 10_000_000, suffix: "C" },
  B: { divisor: 1_000_000_000, suffix: "B" },
}

// True locale-based auto: detects whether the viewer's own OS/browser locale uses the Indian
// numbering system, so "autoLocale" can pick between the two tiering systems below rather than
// forcing a fixed one — the one genuinely "auto" mode of the three, in the sense that it reads
// something outside the field's own config to decide.
function detectIndianLocale(): boolean {
  try {
    return /-in$/i.test(new Intl.NumberFormat().resolvedOptions().locale)
  } catch {
    return false
  }
}

// Cell-value formatter that respects a field's Formatting-panel override, if any. With no
// override (or one left fully at "auto"/null) this is byte-for-byte fmtNum's own behavior —
// only an explicit decimals/units edit in the panel changes anything for that field.
// Wraps a formatted number so the cell also carries its unrounded value. The display text is
// deliberately lossy — "2.0M" for 1,984,200 — and a spreadsheet export that parsed the text back
// would hand Excel numbers whose columns don't add up. Exports read data-v; the UI shows the text.
function numCellValue(n: number, format?: FieldFormat) {
  // NaN marks "no value here" (a metric the Timeline doesn't split, in a period column). Blank,
  // and no data-v, so an export leaves the cell empty rather than writing a 0.
  if (Number.isNaN(n)) return <span />
  return <span data-v={Number.isFinite(n) ? n : 0}>{formatCellValue(n, format)}</span>
}

function formatCellValue(n: number, format?: FieldFormat): string {
  if (!format || (format.units === "auto" && format.decimals === null)) return fmtNum(n)
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  let divisor = 1
  let suffix = ""
  const resolvedUnits = format.units === "autoLocale" ? (detectIndianLocale() ? "autoIN" : "auto") : format.units
  if (resolvedUnits === "auto") {
    if (abs >= 1_000_000_000) ({ divisor, suffix } = UNIT_TIER.B)
    else if (abs >= 1_000_000) ({ divisor, suffix } = UNIT_TIER.M)
    else if (abs >= 1_000) ({ divisor, suffix } = UNIT_TIER.K)
  } else if (resolvedUnits === "autoIN") {
    if (abs >= 10_000_000) ({ divisor, suffix } = UNIT_TIER.C)
    else if (abs >= 100_000) ({ divisor, suffix } = UNIT_TIER.L)
    else if (abs >= 1_000) ({ divisor, suffix } = UNIT_TIER.K)
  } else if (resolvedUnits !== "none" && UNIT_TIER[resolvedUnits]) {
    ({ divisor, suffix } = UNIT_TIER[resolvedUnits])
  }
  const decimals = format.decimals ?? (divisor > 1 ? 1 : 0)
  const scaled = n / divisor
  return `${scaled.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`
}

// The field's custom display name (Formatting panel), falling back to its default name.
function fieldItemLabel(item: PivotItem, fieldFormats: Record<string, FieldFormat>): string {
  const custom = fieldFormats[item.id]?.displayName
  return custom && custom.trim() !== "" ? custom : fieldDisplayName(item.field)
}

// Resolves the CSS text-align class for a header/cell given its format override. "auto"
// preserves today's hardcoded defaults per column kind (Values right-aligned, Rows/Columns
// left-aligned) so this is a no-op until a user explicitly picks an alignment.
function alignClass(format: FieldFormat | undefined, defaultAlign: "left" | "right"): string {
  const align = format?.align && format.align !== "auto" ? format.align : defaultAlign
  return align === "left" ? "text-left" : align === "center" ? "text-center" : "text-right"
}

// Small subdued tag naming a header's owning module — opt-in via the "Show source module in
// headers" report setting, so two same-named fields dropped from different modules (e.g. two
// "Status" fields) stay visually distinguishable in the report itself, not just in the chip's
// title tooltip.
function ModuleTag({ field, show }: { field: string; show: boolean }) {
  if (!show) return null
  return <span className="text-[9px] text-gray-400 font-normal ml-1 normal-case tracking-normal">{fieldKeyModule(field)}</span>
}

// ── Compact (outline) row tree ──────────────────────────────────────────────────
// Compact view collapses every row field into one indented column with expand/collapse,
// the way Excel's "Compact Form" pivot layout does — as opposed to Detail view's one
// column per row field with repeated/spanned labels (the layout already built).

interface CompactNode {
  key: string
  label: string
  level: number
  leafIndices: number[] // indices into displayRows this node aggregates over (a leaf has exactly one)
  children: CompactNode[]
}

function buildCompactTree(rowCombinations: string[][]): CompactNode[] {
  const roots: CompactNode[] = []
  const nodeMap = new Map<string, CompactNode>()

  rowCombinations.forEach((combo, ri) => {
    let path = ""
    let siblings = roots
    for (let level = 0; level < combo.length; level++) {
      const label = combo[level]
      path = level === 0 ? label : `${path} ${label}`
      let node = nodeMap.get(path)
      if (!node) {
        node = { key: path, label, level, leafIndices: [], children: [] }
        nodeMap.set(path, node)
        siblings.push(node)
      }
      node.leafIndices.push(ri)
      siblings = node.children
    }
  })

  return roots
}

function flattenCompactTree(nodes: CompactNode[], collapsed: Set<string>, out: CompactNode[] = []): CompactNode[] {
  for (const node of nodes) {
    out.push(node)
    if (node.children.length > 0 && !collapsed.has(node.key)) {
      flattenCompactTree(node.children, collapsed, out)
    }
  }
  return out
}

// ── Report canvas ──────────────────────────────────────────────────────────────

function ReportCanvas({ source, fields, aggregations, filterRules, viewFilterRules, lookupPaths, timelineFilters, rangeConfigs, fieldFormats, reportView, showTotals, showModuleTag, showProjectCurrency }: {
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  filterRules: FilterRule[]
  viewFilterRules: FilterRule[]
  lookupPaths: Record<string, string>
  timelineFilters: Record<string, MetricFilter>
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  reportView: ReportView
  showTotals: boolean
  showModuleTag: boolean
  showProjectCurrency: boolean
}) {
  // Collapsed compact-tree node keys — declared unconditionally (before the early
  // return below) since hooks can't be called conditionally.
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const hl = useHighlightStyle()
  const toggleCollapsed = (key: string) => setCollapsedNodes((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const isEmpty = fields.values.length === 0 && fields.rows.length === 0 && fields.columns.length === 0

  if (isEmpty) {
    return (
      <div data-print-root className="flex-1 min-w-0 min-h-0 overflow-hidden bg-gray-50 p-5 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center bg-white rounded-xl border border-gray-100 shadow-sm gap-4 select-none">
          <svg width="120" height="88" viewBox="0 0 120 88" fill="none" className="opacity-20">
            <rect x="1" y="1" width="118" height="86" rx="5" stroke="#6366f1" strokeWidth="2" strokeDasharray="6 4" />
            <line x1="1" y1="22" x2="119" y2="22" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="4 3" />
            <line x1="40" y1="22" x2="40" y2="87" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="4 3" />
            <line x1="80" y1="22" x2="80" y2="87" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="4 3" />
            <rect x="10" y="8" width="30" height="8" rx="2" fill="#6366f1" opacity="0.4" />
            <rect x="48" y="32" width="24" height="6" rx="2" fill="#6366f1" opacity="0.25" />
            <rect x="88" y="32" width="20" height="6" rx="2" fill="#6366f1" opacity="0.25" />
            <rect x="48" y="48" width="18" height="6" rx="2" fill="#6366f1" opacity="0.18" />
            <rect x="88" y="48" width="24" height="6" rx="2" fill="#6366f1" opacity="0.18" />
            <rect x="10" y="32" width="22" height="6" rx="2" fill="#6366f1" opacity="0.3" />
            <rect x="10" y="48" width="26" height="6" rx="2" fill="#6366f1" opacity="0.3" />
          </svg>
          <div className="text-center">
            <p className="text-[15px] font-semibold text-gray-700 mb-1">Nothing to show yet</p>
            <p className="text-[13px] text-gray-400 max-w-[260px] leading-relaxed">
              Drag fields from the left panel into the <strong className="text-gray-500 font-medium">Columns</strong>,{" "}
              <strong className="text-gray-500 font-medium">Rows</strong>, or{" "}
              <strong className="text-gray-500 font-medium">Values</strong> zones above
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Row-field labels only — the actual grouping/aggregation is computed for real below.
  const rowSamples = fields.rows.map(item => ({ id: item.id, name: item.field }))

  const report = computeReportData(source, fields, aggregations, filterRules, viewFilterRules, timelineFilters, rangeConfigs, lookupPaths)
  const fanoutNotice = report.fanoutNotice
  const { displayRows, colValues, colTuples, hasColumns, hasValues, cellNum, rowTotal, groupCell, groupTotal, grandTotals, bucketRows, grainModule } = report
  const allLeaves = displayRows.map((_, ri) => ri)
  // The right-hand Grand Total column is a total like the others — the totals toggle hides it too.
  const showColTotal = showTotals && hasColumns && hasValues
  const timelineNotices = report.timelineNotices
  const colItemsAt = (ci: number) => report.colItems[ci].map((vi) => ({ item: fields.values[vi], vi }))
  // A header tier cell spans every measure under its columns — not a fixed count per column,
  // since a Timeline's leading slot holds only the measures it doesn't split.
  const tierSpan = (tierRow: { span: number }[], i: number) => {
    const start = tierRow.slice(0, i).reduce((s, c) => s + c.span, 0)
    return hasValues
      ? report.colItems.slice(start, start + tierRow[i].span).reduce((s, items) => s + items.length, 0)
      : tierRow[i].span
  }
  const colHeaderTiers = hasColumns ? buildColumnHeaderTiers(colTuples) : []

  // "View table values in project's currency" — appends the resolved currency code to a
  // money-typed value cell, but only when every row feeding it agrees on one (see
  // resolveGroupCurrency) and the aggregate is still a monetary quantity (Count/Distinct Count
  // of a money field is a dimensionless count, not an amount, so no currency applies there).
  const currencySuffix = (item: PivotItem, buckets: Row[][]): string => {
    if (!showProjectCurrency || getFieldType(item.field) !== "money") return ""
    const agg = aggregations[item.id] || "Sum"
    if (agg === "Count" || agg === "Distinct Count") return ""
    const code = resolveGroupCurrency(buckets, grainModule)
    return code ? ` ${code}` : ""
  }

  const thCls = "border-b border-r border-gray-200 px-4 py-2.5 text-[12px] font-semibold text-left whitespace-nowrap sticky top-0 z-10"
  const tdCls = "border-b border-r border-gray-100 px-4 py-2 text-[13px] whitespace-nowrap"

  // Track which primary-level rows have already rendered their spanning cell
  const renderedPrimary = new Set<string>()

  // ── Compact (outline) view — one indented column per row instead of one per row field,
  // with expand/collapse. Only applies when there's actually a row hierarchy to collapse.
  if (reportView === "compact" && rowSamples.length > 0) {
    const tree = buildCompactTree(displayRows)
    const flatNodes = flattenCompactTree(tree, collapsedNodes)
    const aggValue = (node: CompactNode, ci: number, vi: number) =>
      groupCell(node.leafIndices, ci, vi)
    const nodeRowTotal = (node: CompactNode, vi: number) =>
      groupTotal(node.leafIndices, vi)
    const nodeBuckets = (node: CompactNode, ci: number) => node.leafIndices.map((ri) => bucketRows(ri, ci))
    const nodeTotalBuckets = (node: CompactNode) =>
      hasColumns ? node.leafIndices.flatMap((ri) => colValues.map((_, ci) => bucketRows(ri, ci))) : nodeBuckets(node, 0)

    return (
      <div data-print-root className="flex-1 min-w-0 min-h-0 overflow-hidden bg-gray-50 p-5 flex flex-col items-start">
        {fanoutNotice && (
          <p className="shrink-0 mb-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
            {fanoutNotice}
          </p>
        )}
        {timelineNotices.map((n) => (
          <p key={n} className="shrink-0 mb-2 text-[12px] text-sky-800 bg-sky-50 border border-sky-200 rounded-md px-3 py-1.5">
            {n}
          </p>
        ))}
        <div className="flex-1 min-h-0 w-fit max-w-full overflow-auto bg-white rounded-xl border border-gray-100 shadow-sm">
          <table data-report-table className="border-collapse text-[13px]">
            <thead>
              {/* One header row per Columns field (outermost first), each colSpan-grouped by
                  the distinct combinations that share that prefix — a true nested pivot
                  header rather than one flattened row. */}
              {colHeaderTiers.map((tierRow, level) => (
                <tr key={level}>
                  <th className={`${thCls} bg-white border-b-0`} colSpan={1} />
                  {tierRow.map((cell, ci) => (
                    <th key={ci}
                      colSpan={tierSpan(tierRow, ci)}
                      className={`${thCls} text-center ${cell.label === "" ? "bg-white" : "bg-indigo-50 text-indigo-600"}`}
                    >
                      {cell.label}
                    </th>
                  ))}
                  {showColTotal && (
                    level === 0 ? (
                      <th colSpan={fields.values.length} className={`${thCls} bg-gray-100 text-gray-600 text-center`}>
                        Grand Total
                      </th>
                    ) : (
                      <th colSpan={fields.values.length} className={`${thCls} bg-gray-100`} />
                    )
                  )}
                </tr>
              ))}
              <tr>
                <th className={`${thCls} bg-gray-50 text-gray-600 min-w-[220px]`}>
                  {rowSamples.map((r, i) => (
                    <Fragment key={r.id}>
                      {i > 0 && " / "}
                      {fieldFormats[r.id]?.displayName || fieldDisplayName(r.name)}
                      <ModuleTag field={r.name} show={showModuleTag} />
                    </Fragment>
                  ))}
                </th>
                {hasColumns
                  ? colValues.flatMap((_, ci) =>
                      colItemsAt(ci).map(({ item, vi }) => (
                        <th key={`${ci}-${vi}`} className={`${thCls} bg-gray-50 ${alignClass(fieldFormats[item.id], "right")} min-w-[110px]`}>
                          <span className="text-[10px] text-gray-400 font-normal mr-1">{isFormulaKey(item.field) ? "" : aggregations[item.id]}</span>
                          <span className="text-emerald-600">{fieldItemLabel(item, fieldFormats)}</span><HighlightHeaderMark field={item.field} />
                          <ModuleTag field={item.field} show={showModuleTag} />
                        </th>
                      ))
                    )
                  : fields.values.map((item, vi) => (
                      <th key={vi} className={`${thCls} bg-indigo-50 ${alignClass(fieldFormats[item.id], "right")} min-w-[130px]`}>
                        <span className="text-[10px] text-indigo-300 font-normal mr-1">{isFormulaKey(item.field) ? "" : aggregations[item.id]}</span>
                        <span className="text-indigo-600">{fieldItemLabel(item, fieldFormats)}</span><HighlightHeaderMark field={item.field} />
                        <ModuleTag field={item.field} show={showModuleTag} />
                      </th>
                    ))
                }
                {showColTotal && fields.values.map((item, vi) => (
                  <th key={`gt-${vi}`} className={`${thCls} bg-gray-100 text-gray-600 ${alignClass(fieldFormats[item.id], "right")} min-w-[110px]`}>
                    {fieldItemLabel(item, fieldFormats)}
                    <ModuleTag field={item.field} show={showModuleTag} />
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {flatNodes.map((node) => {
                const isLeaf = node.children.length === 0
                const showAggregate = isLeaf || showTotals
                const labelCls = isLeaf ? "text-gray-600" : "text-gray-800 font-medium bg-gray-50/60"
                const valueCls = isLeaf ? "text-gray-700" : "text-gray-800 font-medium bg-gray-50/60"

                return (
                  <tr key={node.key} className="hover:bg-indigo-50/30 transition-colors">
                    <td className={`${tdCls} ${labelCls}`}>
                      <span className="inline-flex items-center gap-1.5" style={{ paddingLeft: node.level * 20 }}>
                        {isLeaf ? (
                          <span className="w-[11px] shrink-0" />
                        ) : (
                          <button onClick={() => toggleCollapsed(node.key)} className="text-gray-400 hover:text-gray-600 shrink-0">
                            <span style={{ transform: collapsedNodes.has(node.key) ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>
                              <Ic.ChevDown size={11} />
                            </span>
                          </button>
                        )}
                        {node.label}
                      </span>
                    </td>
                    {!hasValues ? null : !showAggregate ? (
                      <>
                        {hasColumns
                          ? colValues.flatMap((_, ci) => colItemsAt(ci).map(({ vi }) => <td key={`${ci}-${vi}`} className={tdCls} />))
                          : fields.values.map((_, vi) => <td key={vi} className={tdCls} />)}
                        {showColTotal && fields.values.map((_, vi) => <td key={`gt-${vi}`} className={`${tdCls} bg-gray-50`} />)}
                      </>
                    ) : (
                      <>
                        {hasColumns
                          ? colValues.flatMap((_, ci) =>
                              colItemsAt(ci).map(({ item, vi }) => (
                                <td style={hl(item.field, aggValue(node, ci, vi))} key={`${ci}-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} tabular-nums ${valueCls}`}>
                                  {numCellValue(aggValue(node, ci, vi), fieldFormats[item.id])}{currencySuffix(item, nodeBuckets(node, ci))}
                                </td>
                              ))
                            )
                          : fields.values.map((item, vi) => (
                              <td style={hl(item.field, aggValue(node, 0, vi))} key={vi} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} tabular-nums ${valueCls}`}>
                                {numCellValue(aggValue(node, 0, vi), fieldFormats[item.id])}{currencySuffix(item, nodeBuckets(node, 0))}
                              </td>
                            ))
                        }
                        {showColTotal && fields.values.map((item, vi) => (
                          <td style={hl(item.field, nodeRowTotal(node, vi))} key={`gt-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} font-semibold tabular-nums bg-gray-50`}>
                            {numCellValue(nodeRowTotal(node, vi), fieldFormats[item.id])}{currencySuffix(item, nodeTotalBuckets(node))}
                          </td>
                        ))}
                      </>
                    )}
                  </tr>
                )
              })}

              {showTotals && hasValues && (
                <tr className="border-t-2 border-gray-400 bg-gray-50 font-semibold">
                  <td className={`${tdCls} text-gray-800`}>Grand Total</td>
                  {hasColumns
                    ? colValues.flatMap((_, ci) =>
                        colItemsAt(ci).map(({ item, vi }) => (
                          <td key={`${ci}-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-800 tabular-nums`}>
                            {numCellValue(groupCell(allLeaves, ci, vi), fieldFormats[item.id])}{currencySuffix(item, displayRows.map((_, ri) => bucketRows(ri, ci)))}
                          </td>
                        ))
                      )
                    : grandTotals.map((t, vi) => (
                        <td key={vi} className={`${tdCls} ${alignClass(fieldFormats[fields.values[vi].id], "right")} text-gray-900 tabular-nums`}>{numCellValue(t, fieldFormats[fields.values[vi].id])}{currencySuffix(fields.values[vi], displayRows.map((_, ri) => bucketRows(ri, 0)))}</td>
                      ))
                  }
                  {showColTotal && grandTotals.map((t, vi) => (
                    <td key={`gt-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[fields.values[vi].id], "right")} text-gray-900 tabular-nums bg-gray-100`}>{numCellValue(t, fieldFormats[fields.values[vi].id])}{currencySuffix(fields.values[vi], displayRows.flatMap((_, ri) => colValues.map((_, ci) => bucketRows(ri, ci))))}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div data-print-root className="flex-1 min-w-0 min-h-0 overflow-hidden bg-gray-50 p-5 flex flex-col items-start">
      {fanoutNotice && (
        <p className="shrink-0 mb-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
          {fanoutNotice}
        </p>
      )}
      {timelineNotices.map((n) => (
        <p key={n} className="shrink-0 mb-2 text-[12px] text-sky-800 bg-sky-50 border border-sky-200 rounded-md px-3 py-1.5">
          {n}
        </p>
      ))}
      <div className="flex-1 min-h-0 w-fit max-w-full overflow-auto bg-white rounded-xl border border-gray-100 shadow-sm">
        <table data-report-table className="border-collapse text-[13px]">
        <thead>
          {/* Column group header — one row per Columns field (outermost first), each
              colSpan-grouped by the distinct combinations sharing that prefix, rather than
              one row flattening every Columns field into a single joined label. */}
          {colHeaderTiers.map((tierRow, level) => (
            <tr key={level}>
              <th className={`${thCls} bg-white border-b-0`} colSpan={Math.max(1, rowSamples.length)} />
              {tierRow.map((cell, ci) => (
                <th key={ci}
                  colSpan={tierSpan(tierRow, ci)}
                  className={`${thCls} text-center ${cell.label === "" ? "bg-white" : "bg-indigo-50 text-indigo-600"}`}
                >
                  {cell.label}
                </th>
              ))}
              {showColTotal && (
                level === 0 ? (
                  <th colSpan={fields.values.length} className={`${thCls} bg-gray-100 text-gray-600 text-center`}>
                    Grand Total
                  </th>
                ) : (
                  <th colSpan={fields.values.length} className={`${thCls} bg-gray-100`} />
                )
              )}
            </tr>
          ))}

          {/* Field name header */}
          <tr>
            {rowSamples.length === 0
              ? <th className={`${thCls} bg-gray-50 min-w-[150px]`} />
              : rowSamples.map(r => (
                  <th key={r.id} className={`${thCls} bg-gray-50 text-gray-600 ${alignClass(fieldFormats[r.id], "left")} min-w-[150px]`}>
                    {fieldFormats[r.id]?.displayName || fieldDisplayName(r.name)}
                    <ModuleTag field={r.name} show={showModuleTag} />
                  </th>
                ))
            }
            {hasColumns
              ? colValues.flatMap((_, ci) =>
                  colItemsAt(ci).map(({ item, vi }) => (
                    <th key={`${ci}-${vi}`} className={`${thCls} bg-gray-50 ${alignClass(fieldFormats[item.id], "right")} min-w-[110px]`}>
                      <span className="text-[10px] text-gray-400 font-normal mr-1">{isFormulaKey(item.field) ? "" : aggregations[item.id]}</span>
                      <span className="text-emerald-600">{fieldItemLabel(item, fieldFormats)}</span><HighlightHeaderMark field={item.field} />
                      <ModuleTag field={item.field} show={showModuleTag} />
                    </th>
                  ))
                )
              : fields.values.map((item, vi) => (
                  <th key={vi} className={`${thCls} bg-indigo-50 ${alignClass(fieldFormats[item.id], "right")} min-w-[130px]`}>
                    <span className="text-[10px] text-indigo-300 font-normal mr-1">{isFormulaKey(item.field) ? "" : aggregations[item.id]}</span>
                    <span className="text-indigo-600">{fieldItemLabel(item, fieldFormats)}</span><HighlightHeaderMark field={item.field} />
                    <ModuleTag field={item.field} show={showModuleTag} />
                  </th>
                ))
            }
            {showColTotal && fields.values.map((item, vi) => (
              <th key={`gt-${vi}`} className={`${thCls} bg-gray-100 text-gray-600 ${alignClass(fieldFormats[item.id], "right")} min-w-[110px]`}>
                {fieldItemLabel(item, fieldFormats)}
                <ModuleTag field={item.field} show={showModuleTag} />
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {/* With no Row fields and no Values, every raw row collapses into one meaningless
              blank group (rowLabelers is empty, so every combo is "") — rendering it as a
              stray empty <tr> reads as a bug, not "nothing to show". Say so explicitly
              instead; the Columns header above still shows the distinct combinations that
              exist. */}
          {rowSamples.length === 0 && !hasValues ? (
            <tr>
              <td className={`${tdCls} text-gray-400 italic`} colSpan={9999}>
                Add a field to Rows or Values to see data for these columns.
              </td>
            </tr>
          ) : displayRows.map((combo, ri) => {
            const isFirstOfPrimary = rowSamples.length > 1 && !renderedPrimary.has(combo[0])
            if (isFirstOfPrimary) renderedPrimary.add(combo[0])

            // How many rows does this primary value span?
            const spanCount = rowSamples.length > 1
              ? displayRows.filter(r => r[0] === combo[0]).length
              : 1

            const rowTotals = fields.values.map((_, vi) =>
              rowTotal(ri, vi)
            )

            // Subtotal row after last sibling of a primary group
            const isLastOfPrimary = rowSamples.length > 1 &&
              (ri === displayRows.length - 1 || displayRows[ri + 1]?.[0] !== combo[0])

            return (
              <Fragment key={ri}>
                <tr className="hover:bg-indigo-50/30 transition-colors">
                  {/* Row label cells — or blank placeholder when no row fields */}
                  {rowSamples.length === 0
                    ? <td className={tdCls} />
                    : <>
                        {(rowSamples.length === 1 || isFirstOfPrimary) && (
                          <td
                            rowSpan={rowSamples.length > 1 ? spanCount : 1}
                            className={`${tdCls} text-gray-800 font-medium align-top pt-2.5 border-t-2 border-t-gray-200 ${alignClass(fieldFormats[rowSamples[0].id], "left")}`}
                          >
                            {combo[0]}
                          </td>
                        )}
                        {combo.slice(1).map((val, i) => (
                          <td key={i} className={`${tdCls} text-gray-600 ${alignClass(fieldFormats[rowSamples[i + 1].id], "left")}`}>{val}</td>
                        ))}
                      </>
                  }
                  {/* Value cells */}
                  {hasColumns
                    ? colValues.flatMap((_, ci) =>
                        colItemsAt(ci).map(({ item, vi }) => (
                          <td style={hl(item.field, cellNum(ri, ci, vi))} key={`${ci}-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-700 tabular-nums`}>
                            {numCellValue(cellNum(ri, ci, vi), fieldFormats[item.id])}{currencySuffix(item, [bucketRows(ri, ci)])}
                          </td>
                        ))
                      )
                    : fields.values.map((item, vi) => (
                        <td style={hl(item.field, cellNum(ri, 0, vi))} key={vi} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-700 tabular-nums`}>
                          {numCellValue(cellNum(ri, 0, vi), fieldFormats[item.id])}{currencySuffix(item, [bucketRows(ri, 0)])}
                        </td>
                      ))
                  }
                  {showColTotal && rowTotals.map((t, vi) => (
                    <td style={hl(fields.values[vi].field, t)} key={`gt-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[fields.values[vi].id], "right")} font-semibold text-gray-800 tabular-nums bg-gray-50`}>
                      {numCellValue(t, fieldFormats[fields.values[vi].id])}{currencySuffix(fields.values[vi], colValues.map((_, ci) => bucketRows(ri, ci)))}
                    </td>
                  ))}
                </tr>

                {/* Subtotal row after each primary group */}
                {showTotals && isLastOfPrimary && hasValues && (
                  <tr className="bg-gray-50/80 font-semibold text-[12px]">
                    <td className={`${tdCls} text-gray-500 italic pl-6`} colSpan={Math.max(1, rowSamples.length)}>
                      {combo[0]} — Total
                    </td>
                    {hasColumns
                      ? colValues.flatMap((_, ci) =>
                          colItemsAt(ci).map(({ item, vi }) => {
                            const groupIndices = displayRows.flatMap((r, idx) => r[0] === combo[0] ? [idx] : [])
                            const subtotal = groupCell(groupIndices, ci, vi)
                            const buckets = groupIndices.map((absRi) => bucketRows(absRi, ci))
                            return (
                              <td style={hl(item.field, subtotal)} key={`${ci}-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-700 tabular-nums`}>
                                {numCellValue(subtotal, fieldFormats[item.id])}{currencySuffix(item, buckets)}
                              </td>
                            )
                          })
                        )
                      : fields.values.map((item, vi) => {
                          const groupIndices = displayRows.flatMap((r, idx) => r[0] === combo[0] ? [idx] : [])
                          const subtotal = groupCell(groupIndices, 0, vi)
                          const buckets = groupIndices.map((absRi) => bucketRows(absRi, 0))
                          return (
                            <td style={hl(item.field, subtotal)} key={vi} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-700 tabular-nums`}>
                              {numCellValue(subtotal, fieldFormats[item.id])}{currencySuffix(item, buckets)}
                            </td>
                          )
                        })
                    }
                    {showColTotal && fields.values.map((item, vi) => {
                      const groupIndices = displayRows.flatMap((r, idx) => r[0] === combo[0] ? [idx] : [])
                      const subtotal = groupTotal(groupIndices, vi)
                      const buckets = groupIndices.flatMap((absRi) => colValues.map((_, ci) => bucketRows(absRi, ci)))
                      return (
                        <td style={hl(item.field, subtotal)} key={`gt-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-800 tabular-nums bg-gray-100`}>
                          {numCellValue(subtotal, fieldFormats[item.id])}{currencySuffix(item, buckets)}
                        </td>
                      )
                    })}
                  </tr>
                )}
              </Fragment>
            )
          })}

          {/* Grand total */}
          {showTotals && hasValues && (
            <tr className="border-t-2 border-gray-400 bg-gray-50 font-semibold">
              <td className={`${tdCls} text-gray-800`} colSpan={Math.max(1, rowSamples.length)}>Grand Total</td>
              {hasColumns
                ? colValues.flatMap((_, ci) =>
                    colItemsAt(ci).map(({ item, vi }) => (
                      <td key={`${ci}-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[item.id], "right")} text-gray-800 tabular-nums`}>
                        {numCellValue(groupCell(allLeaves, ci, vi), fieldFormats[item.id])}{currencySuffix(item, displayRows.map((_, ri) => bucketRows(ri, ci)))}
                      </td>
                    ))
                  )
                : grandTotals.map((t, vi) => (
                    <td key={vi} className={`${tdCls} ${alignClass(fieldFormats[fields.values[vi].id], "right")} text-gray-900 tabular-nums`}>{numCellValue(t, fieldFormats[fields.values[vi].id])}{currencySuffix(fields.values[vi], displayRows.map((_, ri) => bucketRows(ri, 0)))}</td>
                  ))
              }
              {showColTotal && grandTotals.map((t, vi) => (
                <td key={`gt-${vi}`} className={`${tdCls} ${alignClass(fieldFormats[fields.values[vi].id], "right")} text-gray-900 tabular-nums bg-gray-100`}>{numCellValue(t, fieldFormats[fields.values[vi].id])}{currencySuffix(fields.values[vi], displayRows.flatMap((_, ri) => colValues.map((_, ci) => bucketRows(ri, ci))))}</td>
              ))}
            </tr>
          )}
        </tbody>
        </table>
      </div>
    </div>
  )
}

// ── App root ───────────────────────────────────────────────────────────────────

interface AppState {
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  dragging: boolean
  dragType: FieldType | null
  filterRules: FilterRule[]
}

// Everything the Save CTA persists — the report's actual definition (source, fields, filters,
// per-field config, display settings). Deliberately excludes ephemeral UI state (dragging,
// which alert is showing, reportMode itself, collapsed tree nodes) since none of that is part
// of "the report" a saved-and-reopened view should restore.
interface SavedReport {
  source: string
  fields: PivotFields
  aggregations: Record<string, string>
  lookupPaths: Record<string, string>
  filterRules: FilterRule[]
  viewFilterRules: FilterRule[]
  reportTimelineFilters: Record<string, MetricFilter>
  rangeConfigs: Record<string, RangeConfig>
  fieldFormats: Record<string, FieldFormat>
  reportView: ReportView
  showTotals: boolean
  showModuleTag: boolean
  showProjectCurrency: boolean
  highlightRules?: HighlightRule[]
}

const SAVED_REPORT_KEY = "customReportsV2.savedReport"
const SAVED_VIEWS_KEY = "customReportsV2.savedViews"

function loadSavedReport(): Partial<SavedReport> | null {
  try {
    const raw = localStorage.getItem(SAVED_REPORT_KEY)
    const parsed: Partial<SavedReport> | null = raw ? migrateFieldKeys(JSON.parse(raw)) : null
    if (parsed?.fields) {
      reserveItemIds([...(parsed.fields.columns ?? []), ...(parsed.fields.rows ?? []), ...(parsed.fields.values ?? [])])
    }
    return parsed
  } catch {
    return null
  }
}

export default function App() {
  // Read once on mount — a lazy initializer runs exactly once, before the first render, so this
  // doesn't re-hit localStorage on every re-render.
  const [savedReport] = useState(() => loadSavedReport())

  const [appMode, setAppMode] = useState<AppMode>("reports")
  const [reportMode, setReportMode] = useState<ReportMode>("create")
  const [source, setSource] = useState<AppState["source"]>(savedReport?.source ?? "Project")
  const [fields, setFields] = useState<AppState["fields"]>(savedReport?.fields ?? { columns: [], rows: [], values: [] })
  const [aggregations, setAggregations] = useState<AppState["aggregations"]>(savedReport?.aggregations ?? {})
  // Keyed by CHIP id, not by relationship: the same field dropped twice can resolve two
  // different ways, which a report-level setting could never express.
  const [lookupPaths, setLookupPaths] = useState<Record<string, string>>(savedReport?.lookupPaths ?? {})
  // Switching viewer changes what every current-user filter resolves to, so the whole app has
  // to recompute — a counter is enough, since the name itself lives outside React.
  const [, setViewerTick] = useState(0)
  const [dragging, setDragging] = useState<AppState["dragging"]>(false)
  const [dragType, setDragType] = useState<AppState["dragType"]>(null)
  const [filterRules, setFilterRules] = useState<FilterRule[]>(savedReport?.filterRules ?? [])
  const [viewFilterRules, setViewFilterRules] = useState<FilterRule[]>(savedReport?.viewFilterRules ?? [])
  const [reportTimelineFilters, setReportTimelineFilters] = useState<Record<string, MetricFilter>>(savedReport?.reportTimelineFilters ?? {})
  const [rangeConfigs, setRangeConfigs] = useState<Record<string, RangeConfig>>(savedReport?.rangeConfigs ?? {})
  const [fieldFormats, setFieldFormats] = useState<Record<string, FieldFormat>>(savedReport?.fieldFormats ?? {})
  const [reportView, setReportView] = useState<ReportView>(savedReport?.reportView ?? "detail")
  const [showTotals, setShowTotals] = useState(savedReport?.showTotals ?? true)
  const [showModuleTag, setShowModuleTag] = useState(savedReport?.showModuleTag ?? false)
  const [showProjectCurrency, setShowProjectCurrency] = useState(savedReport?.showProjectCurrency ?? false)
  const [justSaved, setJustSaved] = useState(false)
  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(savedReport?.highlightRules ?? [])
  useFormulas()
  // Rules belong to a field in Values; once that field leaves Values its rules go with it.
  const valueNumberKeys = [...new Set(fields.values.map((v) => v.field).filter((k) => isNumericType(getFieldType(k)) && (!isFormulaKey(k) || !!formulaOf(k))))]
  const valueKeysSig = valueNumberKeys.join("|")
  useEffect(() => {
    setHighlightRules((prev) => {
      const next = prev.filter((r) => valueNumberKeys.includes(r.fieldName))
      return next.length === prev.length ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKeysSig])

  // Save CTA — persists the report definition to localStorage (this app has no backend) so a
  // reload restores it instead of losing everything. Toggling View/Edit is unrelated to this;
  // it only changes which controls are shown, never touches storage on its own.
  // Same dirty check as the tabular builder: serialise the payload Save would write and compare
  // it against the last one written, so the flag can never disagree with what was saved.
  const payloadJson = JSON.stringify({
    source, fields, aggregations, lookupPaths, filterRules, viewFilterRules,
    reportTimelineFilters, rangeConfigs, fieldFormats,
    reportView, showTotals, showModuleTag, showProjectCurrency, highlightRules,
  } satisfies SavedReport)
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(savedReport ? payloadJson : null)
  const savedViews = useSavedViews(SAVED_VIEWS_KEY, reportMode, viewFilterRules, setViewFilterRules)
  const [showNewView, setShowNewView] = useState(false)

  const hasAnyPivotField =
    fields.columns.length > 0 || fields.rows.length > 0 || fields.values.length > 0
  // Chips need the grain to know which of their relationships are ambiguous from here.
  const grainModule = pickGrain(source, fields, filterRules)
  // An empty report has nothing worth saving, so it doesn't get the "unsaved changes" emphasis.
  const dirty = savedSnapshot !== payloadJson && hasAnyPivotField
  // Nothing dropped means nothing to write — saving an empty report would only overwrite a real
  // one already in storage with a blank payload.
  const saveBlockedReason = hasAnyPivotField
    ? null
    : "Add fields to Columns, Rows, or Values before saving this report"

  const viewBlockedReason = !hasAnyPivotField
    ? "Add fields to Columns, Rows, or Values before viewing this report"
    : dirty
      ? "Save your changes to view this report"
      : null

  const handleSave = () => {
    if (saveBlockedReason !== null) return
    try {
      localStorage.setItem(SAVED_REPORT_KEY, payloadJson)
      setSavedSnapshot(payloadJson)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1500)
    } catch {}
  }

  const handleRangeConfigChange = (id: string, cfg: RangeConfig) => {
    setRangeConfigs(prev => ({ ...prev, [id]: cfg }))
  }

  const handleFieldFormatChange = (id: string, patch: Partial<FieldFormat>) => {
    setFieldFormats(prev => ({ ...prev, [id]: { ...DEFAULT_FIELD_FORMAT, ...prev[id], ...patch } }))
  }

  const handleReportTimelineChange = (id: string, f: MetricFilter | null) => {
    setReportTimelineFilters(prev => {
      const next = { ...prev }
      if (f === null) delete next[id]
      else next[id] = f
      return next
    })
  }

  // The Timeline only ever acts on time-tracked metrics, so it stays locked until the report has
  // one — in Values, Rows or Columns.
  const timelineBlocked = timelineMetricItems(fields).length > 0 ? null : "Add a time-tracked metric first"

  const handleFilterDrop = (name: string, type: FieldType) => {
    if (name === TIMELINE_KEY && timelineBlocked) return
    if (fields.columns.length === 0 && fields.rows.length === 0 && fields.values.length === 0) {
      setShowFilterNeedsFieldAlert(true)
      return
    }
    setFilterRules((prev) => {
      if (prev.find((r) => r.field === name)) return prev
      return [...prev, makeFilterRule(name, type)]
    })
    setJustDroppedFilter(name)
  }
  const handleFilterRemove = (field: string) => {
    setFilterRules((prev) => prev.filter((r) => r.field !== field))
  }
  const handleFilterChange = (field: string, patch: Partial<FilterRule>) => {
    setFilterRules((prev) => prev.map((r) => r.field === field ? { ...r, ...patch } : r))
  }

  // View filters — a separate, lower-priority list the builder exposes to viewers. Dropping is
  // deduped within this list only; the same field may also sit in the base Filters above (base
  // locks the scope, the view filter lets a viewer pick within it).
  const handleViewFilterDrop = (name: string, type: FieldType) => {
    if (name === TIMELINE_KEY && timelineBlocked) return
    if (fields.columns.length === 0 && fields.rows.length === 0 && fields.values.length === 0) {
      setShowFilterNeedsFieldAlert(true)
      return
    }
    setViewFilterRules((prev) => {
      if (prev.find((r) => r.field === name)) return prev
      // A numeric view filter defaults to the range slider (the inline card's numeric control),
      // not the checked-value list a base filter starts in.
      const rule = makeFilterRule(name, type)
      return [...prev, isNumericType(type) ? { ...rule, numMode: "range" as const } : rule]
    })
    setJustDroppedFilter(name)
  }
  const handleViewFilterRemove = (field: string) => {
    setViewFilterRules((prev) => prev.filter((r) => r.field !== field))
  }
  const handleViewFilterChange = (field: string, patch: Partial<FilterRule>) => {
    setViewFilterRules((prev) => prev.map((r) => r.field === field ? { ...r, ...patch } : r))
  }

  const [dupAlert, setDupAlert] = useState<string | null>(null) // field KEY when showing duplicate alert
  const [showFilterNeedsFieldAlert, setShowFilterNeedsFieldAlert] = useState(false)
  // Field key of the filter dropped most recently, in either list. A brand-new filter should
  // open its modal so the builder can configure it — but a filter merely being *rendered*
  // shouldn't, or a saved report would pop a modal per chip on every page load. Comparing
  // against this makes "auto-open" mean "just dropped", which is what was actually intended.
  const [justDroppedFilter, setJustDroppedFilter] = useState<string | null>(null)
  const [pendingSource, setPendingSource] = useState<string | null>(null)

  // Every field key encodes its owning module (makeFieldKey), so nothing dropped against the
  // old source carries over meaningfully to a new one — confirm before wiping Columns/Rows/
  // Values/Filters, skipping the prompt only when there's nothing to lose.
  const handleSourceChangeRequest = (next: string) => {
    if (next === source) return
    const isEmpty = fields.columns.length === 0 && fields.rows.length === 0 && fields.values.length === 0
      && filterRules.length === 0 && viewFilterRules.length === 0
    if (isEmpty) { setSource(next); return }
    setPendingSource(next)
  }
  const handleConfirmSourceChange = () => {
    if (!pendingSource) return
    setSource(pendingSource)
    setFields({ columns: [], rows: [], values: [] })
    setAggregations({})
    setLookupPaths({})
    setFilterRules([])
    setViewFilterRules([])
    setReportTimelineFilters({})
    setRangeConfigs({})
    setFieldFormats({})
    setHighlightRules([])
    setPendingSource(null)
  }

  // Each drop is a distinct instance — dropping the same field twice must let each occurrence
  // carry its own aggregation/timeline-filter state, so both are keyed by this fresh id, never
  // by the field key itself (which duplicate pills would otherwise share).
  const dropBlockReason = (zone: PivotZoneKey, field: string, id?: string) =>
    pivotDropBlockReason(source, fields, filterRules, lookupPaths, zone, field, id)
  // A click-to-add has no pointer over a shelf to explain itself at, so it says why up top.
  const [splitNotice, setSplitNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refuseSplit = (zone: PivotZoneKey, field: string, id?: string): boolean => {
    const reason = dropBlockReason(zone, field, id)
    if (!reason) return false
    setSplitNotice(reason)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setSplitNotice(null), 3500)
    return true
  }

  const handleAdd = (zone: PivotZoneKey, field: string, type: FieldType) => {
    if (field === TIMELINE_KEY && timelineBlocked) return
    if (refuseSplit(zone, field)) return
    // Timeline splits metrics into periods, down the rows or across the columns; as a value it
    // would have nothing to add up. One is enough.
    if (field === TIMELINE_KEY
      && (zone === "values" || [...fields.rows, ...fields.columns].some((c) => c.field === TIMELINE_KEY))) return
    const id = nextPivotItemId()
    setFields((prev) => ({ ...prev, [zone]: [...prev[zone], { id, field }] }))
    setAggregations((prev) => {
      let defaultMod: string | undefined
      if (isFormulaKey(field)) defaultMod = undefined
      else if (zone === "values") defaultMod = isNumericType(type) ? "Sum" : "Count"
      else if (field === TIMELINE_KEY) defaultMod = "Month & Year"
      else if (zone === "columns" || zone === "rows") {
        if (isNumericType(type)) defaultMod = "Dimension"
        else if (type === "date") defaultMod = "Quarter & Year"
      }
      return defaultMod ? { ...prev, [id]: defaultMod } : prev
    })
  }

  const handleLookupPathChange = (id: string, path: string) => {
    setLookupPaths((prev) => ({ ...prev, [id]: path }))
  }

  const handleRemove = (zone: PivotZoneKey, id: string) => {
    setFields((prev) => ({ ...prev, [zone]: prev[zone].filter((item) => item.id !== id) }))
  }

  const handleReorder = (zone: PivotZoneKey, id: string, toIndex: number) => {
    setFields((prev) => {
      const item = prev[zone].find((it) => it.id === id)
      if (!item) return prev
      const arr = prev[zone].filter((it) => it.id !== id)
      arr.splice(toIndex, 0, item)
      return { ...prev, [zone]: arr }
    })
  }

  const handleMove = (from: PivotZoneKey, to: PivotZoneKey, id: string) => {
    const item = fields[from].find((it) => it.id === id)
    if (!item) return
    if (item.field === TIMELINE_KEY && to === "values") return
    if (refuseSplit(to, item.field, id)) return
    const type = getFieldType(item.field)
    setFields((prev) => ({
      ...prev,
      [from]: prev[from].filter((it) => it.id !== id),
      [to]: [...prev[to], item],
    }))
    // The Timeline keeps its period size between Rows and Columns.
    if (item.field === TIMELINE_KEY) return
    setAggregations((prev) => {
      let defaultMod: string | undefined
      if (to === "values") defaultMod = isNumericType(type) ? "Sum" : "Count"
      else if (to === "columns" || to === "rows") {
        if (isNumericType(type)) defaultMod = "Dimension"
        else if (type === "date") defaultMod = "Quarter & Year"
      }
      return defaultMod ? { ...prev, [id]: defaultMod } : prev
    })
  }

  const handleAggChange = (id: string, agg: string) => {
    setAggregations((prev) => ({ ...prev, [id]: agg }))
  }

  return (
    <div className="flex h-screen bg-white font-sans">
      <LeftNav appMode={appMode} setAppMode={setAppMode} onViewerChange={() => setViewerTick((t) => t + 1)} />

      {dupAlert && (
        <DupFieldAlert
          name={fieldDisplayName(dupAlert)}
          count={[...fields.columns, ...fields.rows, ...fields.values].filter((item) => item.field === dupAlert).length}
          onClose={() => setDupAlert(null)}
        />
      )}

      {showFilterNeedsFieldAlert && (
        <FilterNeedsFieldAlert onClose={() => setShowFilterNeedsFieldAlert(false)} />
      )}

      {showNewView && (
        <NewViewModal
          existingNames={savedViews.views.map((v) => v.name)}
          onSave={(name, audience, members) => { savedViews.saveView(name, audience, members); setShowNewView(false) }}
          onClose={() => setShowNewView(false)}
        />
      )}

      {pendingSource && (
        <SourceChangeConfirmModal
          nextSource={pendingSource}
          onConfirm={handleConfirmSourceChange}
          onCancel={() => setPendingSource(null)}
        />
      )}

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {appMode === "dashboard" ? (
          <DashboardView />
        ) : appMode === "tabular" ? (
          <TabularBuilder />
        ) : (
          <ReportExtrasHost
            source={source}
            formulaZone="values"
            targets={valueNumberKeys.map((k) => ({ field: k, label: fieldDisplayName(k) }))}
            highlightRules={highlightRules}
            onHighlightRulesChange={setHighlightRules}
            onFormulaCreated={(key) => handleAdd("values", key, "number")}
            onFormulaDeleted={(key) => {
              setFields((prev) => ({ ...prev, values: prev.values.filter((v) => v.field !== key) }))
              setHighlightRules((prev) => prev.filter((r) => r.fieldName !== key))
            }}
          >
            <PageHeader
        reportMode={reportMode} onReportModeChange={setReportMode} onSave={handleSave}
        justSaved={justSaved} dirty={dirty}
        saveBlockedReason={saveBlockedReason} viewBlockedReason={viewBlockedReason}
      />
            <Toolbar
              source={source}
              setSource={handleSourceChangeRequest}
              fields={fields}
              reportView={reportView}
              onReportViewChange={setReportView}
              showTotals={showTotals}
              onShowTotalsChange={setShowTotals}
              fieldFormats={fieldFormats}
              onFieldFormatChange={handleFieldFormatChange}
              showModuleTag={showModuleTag}
              onShowModuleTagChange={setShowModuleTag}
              showProjectCurrency={showProjectCurrency}
              onShowProjectCurrencyChange={setShowProjectCurrency}
              reportMode={reportMode}
              viewBar={
                <SavedViewsBar
                  views={savedViews.views}
                  activeId={savedViews.activeId}
                  activeName={savedViews.activeName}
                  dirty={savedViews.dirty}
                  onPick={savedViews.applyView}
                  onSaveAs={() => setShowNewView(true)}
                  onReset={savedViews.resetView}
                  onDelete={savedViews.deleteView}
                />
              }
            />
            <div className="flex flex-1 overflow-hidden">
              {reportMode === "create" && (
                <FieldBrowser
                  fields={fields}
                  source={source}
                  timelineBlocked={timelineBlocked}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onDupAlert={(name) => setDupAlert(name)}
                  onDragStart={(field, type) => { startDrag(field); setDragging(true); setDragType(type) }}
                  onDragEnd={() => { endDrag(); setDragging(false); setDragType(null) }}
                />
              )}
              {reportMode === "create" && (
                <BuildPanel>
                  <DropZoneBar
                    source={source}
                    fields={fields}
                    dragging={dragging}
                    dragType={dragType}
                    grainModule={grainModule}
                    lookupPaths={lookupPaths}
                    onLookupPathChange={handleLookupPathChange}
                    aggregations={aggregations}
                    timelineFilters={reportTimelineFilters}
                    rangeConfigs={rangeConfigs}
                    fieldFormats={fieldFormats}
                    onDrop={handleAdd}
                    onMove={handleMove}
                    onReorder={handleReorder}
                    onRemove={handleRemove}
                    onAggChange={handleAggChange}
                    onTimelineChange={handleReportTimelineChange}
                    onRangeConfigChange={handleRangeConfigChange}
                    onFieldFormatChange={handleFieldFormatChange}
                    blockReason={dropBlockReason}
                    notice={splitNotice}
                  />
                  <FilterBar
                    rules={filterRules}
                    dragging={dragging}
                    source={source}
                    fields={fields}
                    aggregations={aggregations}
                    rangeConfigs={rangeConfigs}
                    onDrop={handleFilterDrop}
                    onRemove={handleFilterRemove}
                    onRuleChange={handleFilterChange}
                    justDropped={justDroppedFilter}
                  />
                  <ViewFilterPane
                    rules={viewFilterRules}
                    baseRules={filterRules}
                    dragging={dragging}
                    source={source}
                    fields={fields}
                    aggregations={aggregations}
                    rangeConfigs={rangeConfigs}
                    onDrop={handleViewFilterDrop}
                    onRemove={handleViewFilterRemove}
                    onRuleChange={handleViewFilterChange}
                    reportMode={reportMode}
                  />
                </BuildPanel>
              )}
              <div className="flex flex-col flex-1 min-w-0">
                {/* Canvas + View filters share a row BELOW the shelves, so Columns/Rows/Values
                    and the Filters bar run the full width to the right edge — the view filter
                    rail is a companion to the report, not to the whole builder. */}
                <div className="flex flex-1 overflow-hidden">
                  <ReportCanvas
                    source={source}
                    fields={fields}
                    aggregations={aggregations}
                    filterRules={filterRules}
                    viewFilterRules={viewFilterRules}
                    lookupPaths={lookupPaths}
                    timelineFilters={reportTimelineFilters}
                    rangeConfigs={rangeConfigs}
                    fieldFormats={fieldFormats}
                    reportView={reportView}
                    showTotals={showTotals}
                    showModuleTag={showModuleTag}
                    showProjectCurrency={showProjectCurrency}
                  />
                  {reportMode === "view" && (
                    <ViewFilterPane
                      rules={viewFilterRules}
                      baseRules={filterRules}
                      dragging={dragging}
                      source={source}
                      fields={fields}
                      aggregations={aggregations}
                      rangeConfigs={rangeConfigs}
                      onDrop={handleViewFilterDrop}
                      onRemove={handleViewFilterRemove}
                      onRuleChange={handleViewFilterChange}
                      reportMode={reportMode}
                    />
                  )}
                </div>
              </div>
            </div>
          </ReportExtrasHost>
        )}
      </div>
    </div>
  )
}
