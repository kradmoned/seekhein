# Seekhein interface direction

Design review used **unslop by Damir Sokolovsky**
([skill source](https://github.com/heydamir/unslop), CC BY 4.0).

## Direction

- Product: a Python learning workspace for everyday student use.
- Character: calm, precise, approachable.
- World: a study desk and code notebook; neutral surfaces with the existing blue accent.
- Moments: actual course content, readable source, and clear execution outcomes.
- Signature: restrained code notation and aligned lab numbers.

## Audit and changes

1. **Spacing:** course headers, search, cards, and lab rows use consistent spacing.
   Dense workspace tools remain compact; paragraphs have room to read.
2. **Color:** replaced the olive neutral palette and weak secondary text with
   independent light/dark neutral ramps. Cards, page canvas, sidebar, inputs,
   selection, focus, and popovers have explicit roles. Blue remains the action
   color. Success and warning colors carry meaning and include readable surfaces.
3. **Icons:** navigation, course links, lab tools, and account controls use the
   existing Hugeicons set at a consistent size and stroke.
4. **Copy:** removed sidebar promotional copy and uppercase labels. Course counts
   and lab counts come from existing API data; no invented progress or grades.
5. **Type:** Figtree is the interface family; system monospace remains for code.
   Secondary text is deliberately darker in light mode and lighter in dark mode.
   Removed the competing Outfit/Manrope font downloads from the active stylesheet.
6. **Layout:** course cards prioritize descriptions and lab availability. Course
   labs are scannable numbered rows. Existing responsive, resizable lab panes and
   the Submit/details group are preserved. A skip link supports keyboard access.
7. **Details:** common controls use consistent corner radii, visible borders and
   focus outlines. Draft storage status is explicit. Lab rules are available from
   the instructions header; blocking and delivery warnings remain visible.
8. **Visuals:** no generated artwork or decorative dashboard charts. Monaco has
   matching light/dark themes with readable comments, line numbers and syntax.
   Real course content and test results supply the visual emphasis.
9. **Motion:** common controls transition colors rather than every property.
   Reduced-motion preferences are respected globally.

## Contrast targets

The browser suite checks primary/secondary text, button labels, selected
navigation, semantic notices, and control/focus boundaries in both themes.

| Pair | Light ratio | Dark ratio |
| --- | ---: | ---: |
| Main text / page | 14.79:1 | 16.29:1 |
| Secondary text / card | 6.19:1 | 8.06:1 |
| Secondary text / muted surface | 5.41:1 | 6.93:1 |
| Primary button label / fill | 6.22:1 | 8.47:1 |
| Selected navigation text / fill | 7.52:1 | 8.41:1 |
| Input boundary / card | 3.08:1 | 4.20:1 |

These checks cover the defined token pairs; they are not a claim of a complete
accessibility audit. Browser coverage also checks draft preservation through theme
changes, editor surface matching, responsive layout, and the existing submission
and recovery flows. Screenshots use explicitly mocked course/account data.

Verification: production build and 16 Chrome browser scenarios passed. Targeted
lint checks for the redesigned feature files passed. Existing repository-wide
lint findings in unrelated auth/template primitives remain outside this design pass.

## Notifications and feedback

- `Notice` provides a shared title, icon, readable description, and optional action
  for inline success, info, warning, and error states. Color is limited to the icon
  and border, so the message remains readable in both themes.
- Transient toasts use the already installed Base UI Toast primitives. Successes
  expire after six seconds; editor-policy warnings after eight. Hover/focus pauses
  expiration, and each toast has an accessible dismiss button. At most two are
  visible; repeated blocked editor actions update one toast instead of stacking.
- Toasts do not steal editor focus or change workspace geometry. Editor-policy
  toasts are cleared on leaving the lab; the notification scope resets when the
  signed-in identity changes.
- Failed requests, unavailable storage, telemetry delivery warnings, and unresolved
  submissions stay inline until the problem is resolved. They do not auto-dismiss.
  Run failures provide a Retry run action. Pending submissions retain their review
  and recovery controls.
- Course creation, lab uploads, and policy saves provide brief success toasts.
  Form validation remains beside its form, with explicit error titles. There are
  no native browser alert dialogs in the application flow.
- Accepted final submissions use a completed success notice; no stale “refreshing”
  message remains after the save.

### Course student management

The course detail page keeps labs in the main reading area. Its header pairs Upload lab with a quiet Students action and a live enrollment count. A right-side sheet contains a searchable roster with report links and an Add students tab. The sheet fills the mobile viewport and uses the existing neutral surfaces, Figtree type, and blue selection accent.

CSV imports accept a UTF-8 file with one email column (other columns are ignored), up to 200 data rows and 1 MiB. Preview, validation, duplicate removal, per-row results, and retry of unsuccessful rows use the existing single-email enrollment API. Imports enroll existing accounts; they do not create accounts. Successful requests are not repeated when retrying. Closing is disabled during requests; batch imports can stop after the current request. Progress is held in the current page, not persisted across reloads.

### Lab reports at class scale

The lab report lists ten students per page in a bounded, scrollable result area, with name/email search and filters for accepted finals, no accepted final, activity flags, and incomplete telemetry. Current integrity and telemetry status remain visible beside the latest final and practice count. Stable name ordering prevents integrity updates from constantly reordering the list.

Review opens a right-hand student drawer with Overview, Submissions, and Activity tabs. Histories and event timelines paginate ten entries at a time; integrity flags expand into a bounded list. Polling updates the selected student by ID without resetting filters or the open tab. The current API still returns the full report; pagination here limits rendering and scrolling, not network payload size.

Submitted-code inspection has a persistent Back to report link. Report links carry their originating report URL; lab search, filters, pagination, selected student, drawer tab, and history pages are URL state so returning (or browser Back) restores context. A directly opened submission falls back to its lab report after loading. Return targets are limited to local report routes.

### Teacher lab entry

Teacher lab links open Lab management: student instructions, expandable read-only starter code, submission policy, and the current student integrity policy. Submissions & reports is the primary action; Preview & test explicitly opens the editor. Preview drafts use a separate teacher-preview storage key and do not change the published starter. Student telemetry and final submissions remain disabled in teacher preview. Browser tests assert that teacher management and preview send no events, submission-status, or final-submit requests, while student telemetry and recovery remain functional.
