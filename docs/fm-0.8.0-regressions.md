# fm 0.8.0 GA: one regression, and two wire-format changes worth knowing

Found while moving the Clockwork Inspector from fm 0.8.0-beta.0 (29827611) to
fm 0.8.0 (29834929) on 2026-09-23. Every probe read-only, against
`fmnet://localhost/ooe`.

The upgrade is overwhelmingly an improvement: 44 more register rows reported, the Part
Definition dialog readable for the first time, a portal's sort and filter readable for
the first time, and the layout packed options word replaced by named keys. What follows
is the short list of things that got worse or that will trip a consumer.

## 1. REGRESSION: `read:account` reports `hasPassword: false` for an account that has one

**Severity: high for anything that reports on security.** This is the one item here that
is a defect rather than a change.

| build | `hasPassword` |
|---|---|
| 0.8.0-beta.0 (29827611) | `true` |
| **0.8.0 (29834929)** | **`false`** |

The account, on the reference file:

```
name: dev  |  id: 14  |  userType: fileMakerUser
privilegeSet: [Full Access]  |  enabled: false
```

**The account does have a FileMaker password.** Confirmed by the file's owner. GA
misreports it.

Reproduce with one op:

```
{"op":"read:account","id":14}
```

Why it matters beyond one wrong boolean: `hasPassword: false` on a `fileMakerUser` is
the definition of a password-less account, so a tool that reports on security will
report a **full-access account with no password** — the single loudest finding such a
tool can produce. On this file the account is disabled, which limits real exposure, but
the report does not depend on that and a reader acting on it would be acting on a
falsehood.

It is not a recording artefact: the live read gives the same answer as the recording.

**How this repo handles it.** Three tests in `tests/tabs/security.test.mjs` are marked
`todo` rather than re-baselined. They keep asserting the truth — no `fileMakerUser`
account of ooe is password-less — and the `todo` records that fm currently disagrees.
Re-baselining would have encoded "a full-access account has no password" into the suite
as expected truth, which is a false security claim about a real solution. Remove the
`todo` markers when a later build reports the account correctly.

## 2. CHANGE: a calculation fm cannot render exactly moved to a `…Approximate` key

Not a defect — fm being *more* precise — but it silently broke an analysis here, and it
will silently break anything keyed on the plain names.

GA reports a calculation it could not render exactly under a suffixed key instead of the
plain one, wrapped in comment markers, and **does not send the plain key at all**:

```
beta:  { step: "Set Variable", value: "/*<Function Missing>( 2 ) + 4*/" }
GA:    { step: "Set Variable", valueApproximate: "/*<Function Missing>( 2 ) + 4*/" }
```

New keys on `read:script`: `valueApproximate`, `layoutNameApproximate`,
`recordApproximate` (and `customZoomLevel`, which replaces the beta's `stepValue` on
Set Zoom Level).

**The trap.** This repo counts the places where a script names an object by calculation,
keyed on `scriptName`, `layoutName`, `layoutByCalculation`, `objectName`, `fileName`.
One `layoutName` became `layoutNameApproximate`, the key list stopped matching it, and
the count fell from 63 places to 62 — the tool quietly stopped reporting a site it had
been reporting. Nothing failed loudly; a pinned count moved by one.

The fix is to strip the suffix before the lookup rather than extend the list, so any
future `…Approximate` variant is handled without another edit. The reasoning matters as
much as the fix: a name from a calculation fm cannot even render is **more** uncertain
than an ordinary one, so it belongs in that count more, not less.

**For anyone upgrading:** grep your key lists for the five names above, and for `value`,
`record` and `stepValue` on script steps.

## 3. CHANGE: `geometry` was re-scoped, not merely extended

The layout key `geometry` survives with a different membership. Four of its members
moved out:

| beta | GA |
|---|---|
| `geometry.pageMargins.{top,bottom,left,right}` | `printing.pageMargins.{…}` |
| `geometry.printColumns.{count,width}` | `printing.columns.{count,width}` |
| `geometry.facingPages` | `printing.facingPages` |
| `geometry.rowHeight` | `tableView.rowHeight` |

What remains under `geometry` is dimensional only: `units`, `baseWidth`, `bodyHeight`,
`tableHeaderSize`, `layoutType`, `orientation`, `clientType`. The split is sensible —
`geometry` is now about the layout's shape, `printing` and `tableView` about behaviour —
but it is a rename, and a consumer reading `geometry.pageMargins` gets `undefined`
rather than an error.

Note also that `printing.columns`, `printing.pageMargins` and `tableView.rowHeight` are
reported **only on a layout using each feature**. An absent key means "not used", not
"not reported", and a consumer that renders a zero there invents a value.

## 4. NOT a regression, but worth recording: the packed options word is gone

`layout.flags` and its `raw` / `set` / `areDefaults` members are absent from all 18
layouts and all 475 layout objects of the reference file. Named keys replace them:
`quickFind`, `saveRecordChangesAutomatically`, `showCurrentRecordIndicator`,
`showFieldAlerts`, `showFieldFramesWhenActive`, `delineateCurrentRecordOnly`,
`textRuler`, `verticalPartLabels`, plus the `tableView.*` and `printing.*` groups.

This is the change that produced most of the coverage gain, and the reason is worth
stating: **a named key is present as `false` when the option is off**, where a bit could
only ever be observed on a layout that had it set. Rows that were unscoreable became
scoreable.

Script steps still carry `flags`, and GA now sends it **even when zero** — on all 3104
steps of the reference file, where the beta omitted it when empty.

## Measurement notes

- fm 0.8.0 (29834929), macOS, against `fmnet://localhost/ooe` and its external data
  source `BrojDva`.
- Key sets compared by walking every `read:*` response of a full discovery under both
  builds and diffing the flattened key paths, rather than by reading release notes.
  Three ops changed: `read:layout` (+60 / −14), `read:script` (+4),
  `read:fileOptions` (+1, `spellAsYouType`, which the beta's own help called "not
  reported and not writable yet").
- The account finding was reproduced against the live file, not only the recording.
