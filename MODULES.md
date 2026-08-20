# Custom Reports — modules and fields

Two things, in order: which modules each source can use, then the fields every module offers in the builder.

**A module's fields never change with the source you pick.** The source decides which modules you can reach; the module decides what it contains.

Caps are ceilings, not quotas: **20** fields for a module that can be the source, **15** for a joined one. Anything not listed stays reachable behind search.

---

## Which modules each source can use

**Time tracking** — 11 modules  
[Time tracking](#time-tracking) ·  [Project](#project) ·  [People](#people) ·  [Role](#role) ·  [Phase](#phase) ·  [Task](#task) ·  [Budget](#budget) ·  [Invoice](#invoice) ·  [Capacity](#capacity) ·  [Expense](#expense) ·  [Allocations](#allocations)

**Project** — 17 modules  
[Project](#project) ·  [Phase](#phase) ·  [Time tracking](#time-tracking) ·  [People](#people) ·  [Capacity](#capacity) ·  [Budget](#budget) ·  [Account](#account) ·  [Task](#task) ·  [Actual financials](#actual-financials) ·  [Allocations](#allocations) ·  [Estimated financials](#estimated-financials) ·  [Leave & holiday](#leave-holiday) ·  [Expense](#expense) ·  [Invoice](#invoice) ·  [Project members](#project-members) ·  [Daily rollup](#daily-rollup) ·  [Assignee effort](#assignee-effort)

**Task** — 11 modules  
[Task](#task) ·  [Project](#project) ·  [Time tracking](#time-tracking) ·  [Budget](#budget) ·  [Role](#role) ·  [People](#people) ·  [Account](#account) ·  [Allocations](#allocations) ·  [Epic](#epic) ·  [Sprint](#sprint) ·  [Assignee effort](#assignee-effort)

**Budget** — 12 modules  
[Budget](#budget) ·  [Project](#project) ·  [Invoice](#invoice) ·  [Phase](#phase) ·  [Time tracking](#time-tracking) ·  [Account](#account) ·  [Actual financials](#actual-financials) ·  [Expense](#expense) ·  [Revenue entries](#revenue-entries) ·  [Estimated financials](#estimated-financials) ·  [Forms](#forms) ·  [Task](#task)

**People** — 11 modules  
[People](#people) ·  [Role](#role) ·  [Time tracking](#time-tracking) ·  [Capacity](#capacity) ·  [Project](#project) ·  [Leave & holiday](#leave-holiday) ·  [Actual financials](#actual-financials) ·  [Allocations](#allocations) ·  [Account](#account) ·  [Estimated financials](#estimated-financials) ·  [Daily rollup](#daily-rollup)

**Role** — 11 modules  
[Role](#role) ·  [People](#people) ·  [Time tracking](#time-tracking) ·  [Capacity](#capacity) ·  [Allocations](#allocations) ·  [Actual financials](#actual-financials) ·  [Leave & holiday](#leave-holiday) ·  [Project](#project) ·  [Estimated financials](#estimated-financials) ·  [Daily rollup](#daily-rollup) ·  [Task](#task)

**Account** — 10 modules  
[Account](#account) ·  [Project](#project) ·  [Actual financials](#actual-financials) ·  [Time tracking](#time-tracking) ·  [Invoice](#invoice) ·  [Revenue entries](#revenue-entries) ·  [Budget](#budget) ·  [Meeting](#meeting) ·  [Daily rollup](#daily-rollup) ·  [Task](#task)

**Forms** — 6 modules  
[Forms](#forms) ·  [Project](#project) ·  [Account](#account) ·  [Task](#task) ·  [Phase](#phase) ·  [People](#people)

---

## Fields by module

### Account

`company` · **can be a source** · 12 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Company name | `companyName` | text · `String` |  |  |
| Company owner | `accountOwnerStr` | text · `String` |  |  |
| ARR | `annualizedRecurringRevenue` | money · `Float64` |  |  |
| Company stage | `companystageStr` | text · `String` |  |  |
| Company health | `companyhealthStr` | text · `String` |  |  |
| Last activity | `lastActivityDate` | date · `UInt64` epoch millis |  |  |
| Company type | `companyType` | text · `String` |  |  |
| Capacity | `capacity` | hours · `Nullable(Float64)` |  |  |
| Capacity Minutes | `capacityMinutes` | hours · `Nullable(Float64)` |  |  |
| Is active | `isActive` | yes/no · `Bool` |  |  |
| Is strategic | `isStrategic` | yes/no · `Bool` |  |  |
| Contract Renewal Date | `contractRenewalDate` | date · `UInt64` epoch millis |  |  |

### Budget

`project_financials_budget` · **can be a source** · 15 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Budget name | `projectFinancialsBudgetName` | text · `Nullable(String)` |  |  |
| Project Budget | `projectBudget` | money · `Nullable(Float64)` |  |  |
| Budget Tracked Minutes | `budgetTrackedMinutes` | hours · `Float64` |  |  |
| Budget Remaining Minutes | `budgetRemainingMinutes` | hours · `Float64` |  |  |
| Estimate At Completion | `budgetEstimateAtCompletion` | money · `Float64` |  |  |
| RevRec type | `revenueRecognitionType` | text · `Nullable(String)` |  |  |
| Budgeted Hours | `budgetedHours` | hours · `Nullable(Float64)` |  |  |
| Contract type | `financialContractType` | text · `Nullable(String)` |  |  |
| Is default | `isDefault` | yes/no · `Bool` |  |  |
| Budget End Date | `endDate` | date · `Nullable(UInt64)` epoch millis |  |  |
| Budget Start Date | `startDate` | date · `Nullable(UInt64)` epoch millis |  |  |
| Budget Actual Cost | `budgetActualCost` | money · `Float64` |  |  |
| Budget Actual Revenue | `budgetActualRevenue` | money · `Float64` |  |  |
| Budget Estimated Cost | `budgetEstimatedCost` | money · `Float64` |  |  |
| Budget Estimated Revenue | `budgetEstimatedRevenue` | money · `Float64` |  |  |

Joins on: `companyId` → Account · `projectId` → Project

### Forms

`form_meta` · **can be a source** · 5 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Template Name | `templateName` | text · `String` |  |  |
| Submission Date | `submissionDate` | date · `UInt64` epoch millis |  |  |
| Submitted By | `submittedBy` | number · `UInt64` |  |  |
| Template Version Id | `templateVersionId` | text · `String` |  |  |
| Answer Id | `answerId` | id · `UInt64` |  |  |

Joins on: `companyId` → Account · `instanceId` → Form questions · `instanceId` → Task · `projectId` → Project · `taskId` → Task

### People

`user` · **can be a source** · 13 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Team member name | `userName` | text · `String` |  |  |
| Cost rate | `costRate` | money · `Nullable(Float64)` |  |  |
| Team member type | `userType` | text · `String` |  |  |
| Team member status | `userStatus` | text · `String` |  |  |
| Timesheet approver | `timeSheetApprover` | number · `Nullable(UInt64)` |  |  |
| Role | `roleId` | id · `UInt64` | FK | → `role`.`roleId` |
| Utilisation | `—` | % | calculated |  |
| Total capacity | `—` | hours | calculated |  |
| Available capacity | `—` | hours | calculated |  |
| Billable utilisation | `—` | % | calculated |  |
| Effective capacity | `—` | hours | calculated |  |
| Planned utilisation | `—` | % | calculated |  |
| Base Capacity | `capacity` | hours · `Nullable(Int32)` |  |  |

Joins on: `companyId` → Account · `roleId` → Role · `userId` → Capacity

### Project

`project` · **can be a source** · 20 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Project Name | `name` | text · `String` |  |  |
| Customer | `companyIdStr` | text · `String` | FK | → `company`.`companyId` |
| ARR | `annualizedRecurringRevenue` | money · `Float64` |  |  |
| Billing type | `contractType` | text · `String` |  |  |
| Project owner | `projectOwnerStr` | text · `String` |  |  |
| Budget consumed % | `percentageBudgetConsumed` | % · `Float64` |  |  |
| Estimate to completion (ETC) | `estimateToComplete` | money · `Float64` |  |  |
| Estimate at completion (EAC) | `estimateAtCompletion` | money · `Float64` |  |  |
| Project status | `statusStr` | text · `String` |  |  |
| Project currency | `currency` | text · `String` |  |  |
| Due Date | `dueDate` | date · `UInt64` epoch millis |  |  |
| Start Date | `startDate` | date · `UInt64` epoch millis |  |  |
| Project Fee | `projectFee` | money · `Float64` |  |  |
| Available capacity | `—` | hours | calculated |  |
| Project Budget | `projectBudget` | money · `Float64` |  |  |
| Billable utilisation | `—` | % | calculated |  |
| Progress Percent | `progressPercent` | % · `Float64` |  |  |
| Project Cost | `actualCost` | money · `Float64` |  |  |
| Project Profit | `actualProfit` | money · `Float64` |  |  |
| Project Revenue | `actualRevenue` | money · `Float64` |  |  |

Joins on: `companyId` → Account · `currentPhases` → Phase (multi-value) · `partnerCompany` → Account (multi-value) · `teamMembers` → People (multi-value)

### Role

`role` · **can be a source** · 9 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Role name | `roleName` | text · `String` |  |  |
| Role Type | `type` | text · `String` |  |  |
| Cost rate | `costRate` | money · `Nullable(Float64)` |  |  |
| Used By Partners | `usedByPartners` | yes/no · `Bool` |  |  |
| Available capacity | `—` | hours | calculated |  |
| Utilisation | `—` | % | calculated |  |
| Billable utilisation | `—` | % | calculated |  |
| Total capacity | `—` | hours | calculated |  |
| Planned utilisation | `—` | % | calculated |  |

### Task

`task` · **can be a source** · 16 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Task name | `taskName` | text · `String` |  |  |
| Project phase | `phaseName` | text · `Nullable(String)` |  |  |
| Effort | `effort` | hours · `Nullable(Float64)` |  |  |
| Status | `statusStr` | text · `String` |  |  |
| Risk | `atRisk` | yes/no · `Nullable(UInt8)` |  |  |
| Billable | `defaultTimeEntryBillable` | yes/no · `Nullable(Float64)` |  |  |
| Progress | `progress` | % · `Nullable(Float64)` |  |  |
| Priority | `priorityStr` | text · `String` |  |  |
| Completed at | `completedAt` | date · `Nullable(Int64)` epoch millis |  |  |
| RevRec Amount | `milestoneTaskRevenueRecognition` | money · `Nullable(Float64)` |  |  |
| RevRec Task | `isMilestoneRevenueRecognitionTask` | yes/no · `Nullable(UInt8)` |  |  |
| Due date | `dueDate` | date · `Nullable(Int64)` epoch millis |  |  |
| Start date | `startDate` | date · `Nullable(Int64)` epoch millis |  |  |
| Completed tasks | `—` | count | calculated |  |
| Remaining hours | `—` | hours | calculated |  |
| Assignees | `assigneesStr` | text · `Array(String)` | FK* | → `user` (array) |

Joins on: `assignees` → People (multi-value) · `associatedSprintIds` → Sprint (multi-value) · `companyId` → Account · `currentSprintId` → Sprint · `epicId` → Epic · `phaseId` → Phase · `projectFinancialsBudgetIds` → Budget (multi-value) · `projectId` → Project · `responsible` → People (multi-value) · `teams` → Team (multi-value)

### Time tracking

`time-entry` · **can be a source** · 20 of 20 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Activity Name | `activityName` | text · `String` |  |  |
| Tracked Hours | `trackedMinutes` | hours · `UInt64` |  |  |
| Billable Hours | `billableMinutes` | hours · `Nullable(UInt64)` |  |  |
| Billable | `isBillable` | yes/no · `Bool` |  |  |
| Category | `category` | number · `UInt64` |  |  |
| Non Billable Hours | `nonBillableMinutes` | hours · `Nullable(UInt64)` |  |  |
| Approved Status | `approvedStatus` | text · `String` |  |  |
| Entry Type | `entryType` | text · `String` |  |  |
| Created date | `date` | date · `UInt64` epoch millis |  |  |
| Actual Cost | `actualCost` | money · `Nullable(Float64)` |  |  |
| Invoiced | `—` | yes/no | calculated |  |
| Approved Hours | `—` | hours | calculated |  |
| Bill rate | `billRate` | money · `Nullable(Float64)` |  |  |
| Cost rate | `costRate` | money · `Nullable(Float64)` |  |  |
| Unapproved Hours | `—` | hours | calculated |  |
| Actual Revenue | `actualRevenue` | money · `Nullable(Float64)` |  |  |
| Status | `status` | text · `String` |  |  |
| Actual Margin | `—` | money | calculated |  |
| Actual Profit | `actualProfit` | money · `Nullable(Float64)` |  |  |
| Rejected Hours | `—` | hours | calculated |  |

Joins on: `companyId` → Account · `invoiceId` → Invoice · `projectFinancialsBudgetId` → Budget · `projectId` → Project · `projectPhaseId` → Phase · `roleId` → Role · `taskId` → Task · `userId` → People

### Actual financials

`actual_financials_star_meta` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Actual Revenue | `actualRevenue` | money · `Float64` |  |  |
| Actual Cost | `actualCost` | money · `Float64` |  |  |
| Actual Margin | `actualMargin` | money · `Float64` |  |  |
| Actual Profit | `actualProfit` | money · `Float64` |  |  |
| Actual Expense Cost | `actualExpenseCost` | money · `Float64` |  |  |
| Actual Time Cost | `actualTimeCost` | money · `Float64` |  |  |
| Bill Rate | `billRate` | money · `Float64` |  |  |
| Billable Hours | `billableMinutes` | hours · `Float64` |  |  |

Joins on: `budgetId` → Budget · `customerId` → Account · `projectId` → Project · `projectId` → Estimated financials · `roleId` → Role · `teamId` → Team · `userId` → People

### Allocations

`resource_allocation` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Allocated Mins Raw | `allocatedMins` | hours · `UInt64` |  |  |
| Allocation Type | `allocationType` | text · `String` |  |  |
| Is Billable | `isBillable` | yes/no · `Bool` |  |  |
| Allocated hours | `—` | hours | calculated |  |
| Hard allocated hours | `—` | hours | calculated |  |
| Soft allocated hours | `—` | hours | calculated |  |
| Work Type | `workType` | text · `Nullable(String)` |  |  |
| Allocated Seconds | `allocatedSeconds` | hours · `UInt64` |  |  |

Joins on: `projectFinancialsBudgetId` → Budget · `projectId` → Project · `projectPhaseId` → Phase · `roleId` → Role · `teamId` → Team · `userId` → People · `workId` → Task

### Assignee effort

`task-effort` · 1 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Assignee effort | `effort` | hours · `Float64` |  |  |

Joins on: `projectFinancialsBudgetId` → Budget · `projectId` → Project · `taskId` → Task · `teamId` → Team · `userId` → People

### Backlog

`backlog` · 2 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Backlog name | `backlogName` | text · `String` |  |  |
| Backlog owner | `backlogOwner` | number · `UInt64` |  |  |

Joins on: `epics` → Epic (multi-value) · `projects` → Project (multi-value)

### Capacity

`capacity` · 3 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Team member status | `status` | text · `String` |  |  |
| Capacity | `—` | hours | calculated |  |
| Date | `date` | date · `UInt64` epoch millis |  |  |

Joins on: `roleId` → Role · `userId` → People

### Credit notes

`credit_note` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Credit note number | `creditNoteNumber` | text · `String` |  |  |
| Currency | `currency` | text · `String` |  |  |
| Invoice number | `invoiceNumber` | text · `String` |  |  |
| Status | `status` | text · `String` |  |  |
| Amount | `amount` | money · `Float64` |  |  |
| Project financials budgets | `projectFinancialsBudgets` | money · `Array(UInt64)` |  |  |
| Sub total | `subTotal` | money · `Float64` |  |  |
| Tax | `tax` | money · `Float64` |  |  |

Joins on: `companyId` → Account · `invoiceId` → Invoice · `projects` → Project (multi-value)

### Daily rollup

`star-schema-meta` · 15 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Billable Utilisation | `billableUtilisation` | % · `Float64` |  |  |
| Capacity in minutes | `capacityInMinutes` | hours · `Int32` |  |  |
| Utilisation | `utilisation` | % · `Float64` |  |  |
| Actual Cost | `actualCost` | money · `Float64` |  |  |
| Actual Margin | `actualMargin` | money · `Float64` |  |  |
| Actual Revenue | `actualRevenue` | money · `Float64` |  |  |
| Actual profit | `actualProfit` | money · `Float64` |  |  |
| Allocated Hours | `allocatedMins` | hours · `Float64` |  |  |
| Bill rate | `billRate` | money · `Float64` |  |  |
| Cost rate | `costRate` | money · `Float64` |  |  |
| Estimated Margin | `estimatedMargin` | money · `Float64` |  |  |
| Estimated Profit | `estimatedProfit` | money · `Float64` |  |  |
| Estimated Revenue | `estimatedRevenue` | money · `Float64` |  |  |
| Estimated cost | `estimatedCost` | money · `Float64` |  |  |
| Hard Allocated Hours | `hardAllocatedMins` | hours · `Float64` |  |  |

Joins on: `budgetId` → Budget · `customerId` → Account · `projectId` → Project · `roleId` → Role · `teamId` → Team · `userId` → People

### Epic

`epic` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Epic name | `epicName` | text · `String` |  |  |
| Epic owner | `epicOwnerStr` | text · `String` |  |  |
| Epic squad | `epicSquadStr` | text · `Array(String)` | FK* | → `user` (array) |
| Epic status | `statusStr` | text · `String` |  |  |
| Priority str | `priorityStr` | text · `String` |  |  |
| Effort | `effort` | hours · `UInt64` |  |  |
| Task progress | `taskProgress` | % · `Nullable(Float64)` |  |  |
| Tracked hours | `trackedHours` | hours · `UInt64` |  |  |

Joins on: `epicSquad` → People (multi-value) · `projects` → Project (multi-value)

### Estimated financials

`estimated_financials_star_meta` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Estimated Revenue | `estimatedRevenue` | money · `Float64` |  |  |
| Estimated Cost | `estimatedCost` | money · `Float64` |  |  |
| Allocated Hours | `allocatedMins` | hours · `Float64` |  |  |
| Estimated Margin | `estimatedMargin` | money · `Float64` |  |  |
| Estimated Profit | `estimatedProfit` | money · `Float64` |  |  |
| Hard Allocated Hours | `hardAllocatedMins` | hours · `Float64` |  |  |
| Soft Allocated Hours | `softAllocatedMins` | hours · `Float64` |  |  |
| Bill Rate | `billRate` | money · `Float64` |  |  |

Joins on: `budgetId` → Budget · `customerId` → Account · `projectId` → Project · `projectId` → Actual financials · `roleId` → Role · `teamId` → Team · `userId` → People

### Expense

`expense` · 8 of 15 fields

> No name column, so a report grouped by this shows ids.

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Amount | `amount` | money · `Float64` |  |  |
| Billable Amount | `billableAmount` | money · `Nullable(Float64)` |  |  |
| Currency | `currency` | text · `String` |  |  |
| Expense status | `status` | text · `String` |  |  |
| Reimburse To Source Type | `reimburseToSourceType` | text · `String` |  |  |
| Non Billable Amount | `nonBillableAmount` | money · `Nullable(Float64)` |  |  |
| Non Reimbursable Amount | `nonReimbursableAmount` | money · `Nullable(Float64)` |  |  |
| Reimbursable Amount | `reimbursableAmount` | money · `Nullable(Float64)` |  |  |

Joins on: `allApprovers` → People (multi-value) · `expenseBudgetId` → Expense budget · `expenseOwnerId` → People · `expenseReportId` → Expense report · `invoiceId` → Invoice · `projectFinancialsBudgetId` → Budget · `projectId` → Project · `projectPhaseId` → Phase · `taskId` → Task

### Expense budget

`expense_budget` · 5 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Expense budget | `expenseBudgetName` | text · `String` |  |  |
| Currency | `currency` | text · `String` |  |  |
| Amount | `amount` | money · `Float64` |  |  |
| Billable | `billable` | yes/no · `Bool` |  |  |
| Enabled | `enabled` | yes/no · `Nullable(Bool)` |  |  |

Joins on: `projectFinancialsBudgetId` → Budget · `projectId` → Project

### Expense report

`expense_report` · 4 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Expense report | `expenseReportName` | text · `String` |  |  |
| Currency | `currency` | text · `String` |  |  |
| Expense report status | `status` | text · `String` |  |  |
| Total Amount | `totalAmount` | money · `Float64` |  |  |

Joins on: `expenseOwnerId` → People · `projectId` → Project

### Form questions

`question_instance_map` · 0 of 15 fields

*No fields — this module contributes its relationship only.*

### Invoice

`invoice` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Invoice number | `invoiceNumber` | text · `String` |  |  |
| Amount | `amount` | money · `Float64` |  |  |
| Amount Outstanding | `amountOutstanding` | money · `Float64` |  |  |
| Invoice status | `status` | text · `String` |  |  |
| Date of Issue | `dateOfIssue` | number · `Nullable(UInt64)` |  |  |
| Payment status | `paymentStatus` | text · `String` |  |  |
| Paid Amount | `paidAmount` | money · `Float64` |  |  |
| Currency | `currency` | text · `String` |  |  |

Joins on: `companyId` → Account · `projectFinancialsBudgets` → Budget (multi-value) · `projects` → Project (multi-value)

### Leave & holiday

`leave-schema-meta` · 6 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Total leave | `—` | hours | calculated |  |
| Holiday | `—` | hours | calculated |  |
| Timeoff | `—` | hours | calculated |  |
| Source Type | `objectType` | text · `String` |  |  |
| Duration | `duration` | hours · `UInt16` |  |  |
| Date | `date` | date · `UInt64` epoch millis |  |  |

Joins on: `roleId` → Role · `userId` → People

### Meeting

`meeting` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Meeting name | `meetingName` | text · `Nullable(String)` |  |  |
| Meeting type | `meetingType` | text · `Nullable(String)` |  |  |
| Duration seconds | `durationSeconds` | hours · `Nullable(Int64)` |  |  |
| Deal stage | `dealStage` | text · `Nullable(String)` |  |  |
| Meeting status | `meetingStatus` | text · `Nullable(String)` |  |  |
| Pipeline status | `pipelineStatus` | text · `Nullable(String)` |  |  |
| Source label | `sourceLabel` | text · `Nullable(String)` |  |  |
| Is transcript available | `isTranscriptAvailable` | yes/no · `Bool` |  |  |

Joins on: `companyId` → Account · `participants` → People (multi-value)

### Phase

`phase` · 6 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Project phase | `projectPhaseName` | text · `String` |  |  |
| Phase status | `statusStr` | text · `String` |  |  |
| Completed at | `completedAt` | date · `Nullable(UInt64)` epoch millis |  |  |
| Due date | `dueDate` | date · `Nullable(UInt64)` epoch millis |  |  |
| Start date | `startDate` | date · `Nullable(UInt64)` epoch millis |  |  |
| Start date actual | `startDateActual` | date · `Nullable(UInt64)` epoch millis |  |  |

Joins on: `companyIds` → Account (multi-value) · `projectId` → Project

### Policy checks

`policy_execution` · 8 of 15 fields

> No name column, so a report grouped by this shows ids.

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Entity Type | `entity_type` | text · `String` |  |  |
| Policy Sub Type | `policy_sub_type` | text · `String` | PK |  |
| Policy Type | `policy_type` | text · `String` | PK |  |
| Is Violated | `is_violated` | yes/no · `Bool` |  |  |
| Created At | `created_at` | date · `DateTime64` |  |  |
| Updated At | `updated_at` | date · `DateTime64` |  |  |
| Execution Time Ms | `execution_time_ms` | number · `Nullable(Int64)` |  |  |
| Parallel Batch | `parallel_batch` | number · `Nullable(Int32)` |  |  |

Joins on: `entity_id` → Time tracking

### Project members

`project-membership` · 4 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Source type | `sourceType` | text · `String` |  |  |
| Active | `active` | yes/no · `Bool` |  |  |
| Is default | `isDeafult` | yes/no · `Bool` |  |  |
| Joined at | `joinedAt` | date · `String` |  |  |

Joins on: `projectId` → Project · `userId` → People

### Project teams

`project-team` · 1 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Joined at | `joinedAt` | date · `UInt64` epoch millis |  |  |

Joins on: `projectId` → Project · `roleId` → Role · `teamId` → Team

### Revenue entries

`revenue_entry` · 4 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Revenue to recognise | `amountToRecognise` | money · `Float64` |  |  |
| Amount (Account Currency) | `amountInAccountCurrency` | money · `Float64` |  |  |
| End Date | `endDate` | date · `UInt64` epoch millis |  |  |
| Start Date | `startDate` | date · `UInt64` epoch millis |  |  |

Joins on: `companyId` → Account · `projectFinancialsBudgetId` → Budget · `projectId` → Project

### Signals

`signal_occurrence` · 7 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Signal | `title` | text · `String` |  |  |
| Signal type | `signalType` | text · `String` |  |  |
| Source type | `sourceType` | text · `String` |  |  |
| Reported by | `reportedBy` | number · `Nullable(UInt64)` |  |  |
| Reported by email | `reportedByEmail` | text · `Nullable(String)` |  |  |
| Reported by emails | `reportedByEmails` | text · `Array(String)` |  |  |
| Summary | `summary` | text · `Nullable(String)` |  |  |

Joins on: `companyId` → Account · `meetingId` → Meeting · `reportedByUsers` → People (multi-value)

### Sprint

`sprint` · 8 of 15 fields

| Field | Column | Datatype | Key | Lookup |
|---|---|---|---|---|
| Sprint name | `sprintName` | text · `String` |  |  |
| Sprint owner | `sprintOwnerStr` | text · `String` |  |  |
| Sprint squad | `sprintSquadStr` | text · `Array(String)` | FK* | → `user` (array) |
| Sprint status | `statusStr` | text · `String` |  |  |
| Sprint type | `sprintType` | text · `String` |  |  |
| Actual duration | `actualDuration` | hours · `UInt64` |  |  |
| Duration | `duration` | hours · `UInt64` |  |  |
| Effort in minutes | `effortInMinutes` | hours · `UInt64` |  |  |

Joins on: `associatedEpics` → Epic (multi-value) · `associatedProjects` → Project (multi-value) · `sprintSquad` → People (multi-value)

### Team

`team` · 0 of 15 fields

> No table exists yet — nothing to query until it is built.

*No fields — this module contributes its relationship only.*

### Team membership

`user-team-membership` · 0 of 15 fields

*No fields — this module contributes its relationship only.*

Joins on: `projectId` → Project · `roleId` → Role · `teamId` → Team · `userId` → People

