# OpsFlow Project Context and Engineering Instructions

## What is OpsFlow?

OpsFlow is a professional B2B SaaS platform designed to manage and automate operational workflows.

The initial real-world use case is warehouse and logistics operations.

The first two major business domains are:

1. Production
2. Shipping

Today, many of these workflows are performed manually using Excel spreadsheets, emails, phone calls, and human coordination.

The goal of OpsFlow is to centralize operational data and workflows into one system.

The long-term philosophy is:

> Automate repetitive operational work while allowing humans to review, approve, and resolve exceptions.

OpsFlow is NOT intended to be:

- A generic chatbot
- An AI wrapper
- A generic CRM
- A project management tool
- An invoicing application
- A content generation application

It is operational workflow software.

---

# Business Context

## Production

Production currently works from Excel-based QA spreadsheets.

The spreadsheet contains operational data for a particular week.

Production typically begins around Sunday night.

Production data may contain multiple markets or operational areas, such as:

- Front End
- Back End
- Providence/Boston
- Other markets

The production workflow includes concepts such as:

- Operational Week
- Market
- Machine
- ZIP
- Production Status
- Completion Progress

Initially, a ZIP may have a blank status.

As production progresses, an employee updates the status to indicate that work is complete.

The current manual process is approximately:

Excel QA Sheet
↓
Machines Run
↓
Employee Checks Production
↓
ZIP Status Updated
↓
ZIP/Production Ready

OpsFlow should gradually replace this spreadsheet-based workflow with a dashboard.

The initial production statuses should be flexible and may include:

- NOT_STARTED
- IN_PROGRESS
- COMPLETE
- BLOCKED

Do not assume these are permanent business rules. Design the system so statuses can evolve.

---

# Shipping

Shipping currently uses a weekly Bulk Plan.

The Bulk Plan is primarily a row-based Excel document containing all loads needed for a particular operational week.

Loads may include destinations such as:

- DDUs
- SCFs
- Hubs

A load may contain information such as:

- Load Number
- Carrier
- Destination
- Equipment Size
- Weight
- Number of Stops
- Pickup Date
- Pickup Time
- Delivery Date
- Delivery Time
- Operational Status

The general workflow is:

Customer Service
↓
Planner
↓
Transportation / Load Planning System
↓
Weekly Bulk Plan
↓
Scheduler
↓
Production Status Check
↓
Carrier Communication
↓
Dispatcher
↓
Load Ready / Staged
↓
Driver Loaded
↓
BOL
↓
Delivery
↓
Historical Record

The Scheduler checks upcoming loads against production readiness.

For example:

A Tuesday load may be checked on Monday to determine whether production will be ready.

The Dispatcher ensures that:

- Production is complete
- The load is ready
- The load is staged
- The driver can be loaded

The long-term system should provide a centralized historical record of weekly operations.

For example, users should eventually be able to select:

Week 35

And see:

- Total loads
- Delivered loads
- Delayed loads
- Loads with issues
- Production progress
- Shipping progress
- Exceptions

---

# Production and Shipping Relationship

Currently, Production and Shipping operate using separate Excel-based processes.

There is no direct automated connection between:

Production QA Data

and

Shipping Bulk Plan Data

One of the major long-term goals of OpsFlow is to connect these domains.

The future relationship may look like:

Production
↓
Production Readiness
↓
OpsFlow
↓
Load Readiness
↓
Shipping

However:

Do NOT prematurely implement complicated automatic matching logic.

First establish clean workflows and domain models.

Automation should be introduced after the workflows are validated.

---

# Product Vision

OpsFlow should eventually provide a centralized operational dashboard.

Users should be able to:

- Select an operational week
- View all production activity
- View all shipping activity
- View all loads
- Identify delayed operations
- Identify operational issues
- Track exceptions
- Access historical weekly records

Eventually, different users will have different permissions.

Examples:

Dispatcher:

- Operational load information
- Production readiness
- Load status

Scheduler:

- Weekly loads
- Carrier information
- Production readiness
- Scheduling information

Manager:

- Operational reporting
- Exceptions
- Performance

Finance:

- Load cost
- Payment status
- Financial information

Role-based access will be implemented later.

Do not build authentication or authorization yet unless explicitly requested.

---

# Technology Architecture

OpsFlow uses a TypeScript monorepo.

Current technologies:

- npm workspaces
- Turborepo
- React
- TypeScript
- Vite

Current application:

apps/web

Future backend and infrastructure direction:

- AWS
- AWS CDK
- Amazon S3
- AWS Lambda
- Amazon DynamoDB
- Amazon CloudWatch
- Amazon CloudFront

Expected future architecture:

Frontend
↓
CloudFront
↓
React Application

Backend
↓
API / Lambda

Data
↓
DynamoDB

File Processing
↓
S3
↓
Lambda

Logging
↓
CloudWatch

Do NOT create AWS infrastructure yet.

Do NOT deploy anything.

AWS will be introduced when the application workflow and data model are ready.

---

# Engineering Principles

Follow these rules:

1. Prefer TypeScript.

2. Keep the architecture simple.

3. Do not over-engineer.

4. Do not introduce microservices prematurely.

5. Do not introduce unnecessary dependencies.

6. Prefer stable and widely adopted libraries.

7. Keep Production and Shipping as separate business domains.

8. Keep domain types organized and avoid unnecessary duplication.

9. Prefer readable and maintainable code.

10. Do not create unnecessary abstractions.

11. Do not create folders just for appearance.

12. Build incrementally through milestones.

13. Do not build speculative features.

14. Use realistic dummy data while backend APIs do not exist.

15. Structure the frontend so mock data can later be replaced by APIs.

---

# UI Principles

OpsFlow is professional B2B operational software.

The UI should be:

- Clean
- Professional
- Operational
- Easy to scan
- Desktop-friendly
- Responsive

Prioritize:

- Clear tables
- Status indicators
- Operational information
- Filters
- Search
- Exception visibility
- Fast navigation

Avoid:

- Excessive colors
- Flashy consumer-style design
- Unnecessary animations
- Decorative complexity

The purpose of the UI is to help operational employees make decisions quickly.

---

# Dependency Rules

Before adding a dependency:

1. Check whether the existing stack can solve the problem.
2. Prefer widely adopted libraries.
3. Avoid duplicate libraries.
4. Keep dependencies reasonable.

Potential libraries may include, when needed:

- React Router
- TanStack Query
- React Hook Form
- Zod
- TanStack Table
- Lucide React

Do not install all of these automatically.

Only add a dependency when there is a clear need.

---

# Development Workflow

For meaningful tasks:

1. Inspect the repository first.
2. Understand the existing implementation.
3. Create a concise plan.
4. Implement the requested feature.
5. Run validation.
6. Fix errors.
7. Run validation again.
8. Report results.

Do not simply explain how to make changes if you have the ability to make them directly.

---

# Validation Requirements

Do not claim work is complete without validation.

After meaningful changes:

1. Install dependencies if required.
2. Run the build.
3. Run linting if configured.
4. Run tests if configured.
5. Fix errors caused by the implementation.
6. Re-run validation.

The primary current validation command is:

npm run build

Also inspect relevant package.json scripts and run appropriate commands.

Do not leave known build errors.

---

# Git Rules

You may:

- Inspect files
- Create files
- Modify files
- Install normal development dependencies
- Run development commands
- Run builds
- Run linting
- Run tests

Do NOT automatically:

- Force push
- Rewrite Git history
- Reset user changes
- Delete significant code
- Commit
- Push

unless explicitly instructed.

Always inspect git status before reporting completion.

---

# AWS Safety Rules

Do NOT:

- Create AWS resources without approval
- Deploy infrastructure
- Request AWS credentials unnecessarily
- Create paid services for experimentation

When AWS is introduced later, infrastructure should be reproducible through Infrastructure as Code.

The preferred infrastructure direction is:

AWS CDK + TypeScript.

---

# Current Product Development Roadmap

Development should generally follow these milestones:

## Milestone 1

Application Shell + Production MVP

- Professional application layout
- Navigation
- Dashboard
- Production page
- Realistic dummy data
- ZIP production status workflow
- Local state only

## Milestone 2

Shipping MVP

- Weekly Bulk Plan representation
- Load records
- Carrier information
- Load statuses
- Load details

## Milestone 3

Production + Shipping Integration

- Production readiness
- Load readiness
- Operational visibility between domains

## Milestone 4

Backend Foundation

- APIs
- Data persistence
- Domain services

## Milestone 5

AWS Infrastructure

- AWS CDK
- DynamoDB
- Lambda
- S3
- CloudWatch

## Future Milestones

- Authentication
- Role-based access
- Exception management
- Automation
- Reporting
- Analytics
- Multi-tenant SaaS capabilities

Always focus on the currently assigned milestone.

Do not attempt to build the entire SaaS platform at once.

---

# Definition of Done

A task is complete only when:

- The requested functionality exists.
- The implementation is organized appropriately.
- Relevant validation has been run.
- Build errors caused by the changes are fixed.
- Known issues are reported.
- Git status has been inspected.
