# Student lab assistant — stateful tutor integration

The student workspace has a toggleable resizable assistant panel and a floating launcher. Desktop width is remembered locally; mobile switches between the mounted workspace and assistant. Teachers have no assistant controls or requests.

## Contract and recovery

The frontend validates protocol versions, lifecycle, conversation-wide can_send/blocking_turn_id, and processing/completed/failed/recovery_required statuses. A blocker outside the current page still disables new sends and deletion. Legacy version 1 conversations remain readable with a Start new chat action. Deleting conversations never resume messaging.

Questions capture exact editor code and the displayed saved execution ID. Run supplies attempt_id; accepted finals supply submission_id. No hidden context, tutor credentials, browser history, or upstream keys are sent. Answers and arbitrary reference metadata render as escaped text.

Each question is persisted as lab-chat:<user>:<conversation>:<uuid> before dispatch. Network uncertainty preserves the original action; browser replay keeps the same payload/key. Recover previous answer calls the backend turn recovery endpoint with no body or key and can work without local storage. A history lookup alone never resolves a completed local action; validated replay/recovery does. Matching failed turns release the pending-action block so students can ask a new question, while retaining the old snapshot. Older failed turns can be copied into the composer as a new action, capturing the current editor when sent. Retry-After is honored. Oversized tutor context and tutor authentication failures direct users to administrator help.

## Delete and reset

Delete and Reset require inline confirmation. Unresolved turns must be recovered first. Cleanup failure leaves Retry delete and blocks messaging. Reset intent is saved locally so retry after reload completes deletion before creating a new UUID. Confirmed deletion removes only that conversation's local recovery records; existing lab executions remain untouched. An uncertain conversation creation requires listing before another creation attempt. Restoring a conversation scans further list pages when necessary and falls back when a saved selection has been deleted.

## Deployment boundary

All changes are frontend-only. Backend owners apply 20261128_003_ai_chat.sql and 20261128_004_stateful_tutor.sql in order, drain old processing workers before the latter migration, deploy view=both runner support, and configure server-only TUTOR_API_URL/TUTOR_API_TOKEN. The stateful AI service needs persistent SQLite, completed-turn replay, session cleanup, and MAX_HISTORY_TURNS=3 to retain the original three-exchange window. Backend routes need the documented execution budget. No migrations, secrets, backend edits, or live AI tests are performed by this frontend change.

## Verification

Unit tests cover contract validation, exact snapshots, user/conversation isolation, and failure-state classification. Browser scenarios cover execution matching, lost-response recovery, storage failure, mobile/resizing, pagination/backoff, uncertain creation, recovery outside the loaded page without local storage, definite failure, legacy chats, and interrupted reset across reload. Tests mock backend APIs; deployed runner/tutor smoke tests are still required before release.
