# Build Week eligibility, ownership and repository-access record

Status: `BLOCKED_HUMAN` until the mandatory confirmations below are attached.

Recorded: 2026-07-14

## Verified repository facts

| Check | Evidence | Result |
|---|---|---|
| Repository | `https://github.com/trustphoneapp/zintus` | private |
| Default branch | GitHub repository metadata | `main` |
| Authenticated GitHub account | `gh auth status` | `trustphoneapp` |
| GitHub license detector | repository metadata | `NOASSERTION`/`Other`; GitHub does not recognize the root file as a standard full license text |
| Root license declaration | local `LICENSE` | abbreviated/custom BSL 1.1 declaration for YS Ventures LLC; points to the authoritative standard and changes to Apache-2.0 on 2030-06-20 |
| Root notice | `NOTICE` | identifies Zintus and points to the root license |
| CLI license | `apps/cli/LICENSE` and package metadata | BUSL-1.1 |
| Tokzen license | `packages/tokzen/LICENSE` and package metadata | mixed `MIT AND BUSL-1.1`; quota/ML code is included in exports/distribution, so pure-MIT metadata was corrected in this batch |
| Pre-event/event provenance | `BUILD-WEEK-PROVENANCE.md` | recorded and independently verified |
| Existing judge invitations | GitHub invitations API | not verifiable: current token returns HTTP 403 for invitation listing |

## Frozen recommendation

Keep the Build Week repository **private** and retain its current BSL 1.1 licensing.
Do not relicense the project during the event. Before submission, grant and verify
private access for both required judge accounts:

- `testing@devpost.com`
- `build-week-event@openai.com`

This is a repository-access decision, not a claim that the BSL is an open-source
license. Submission copy must describe it accurately.

## Ownership and third-party checklist

The automated pass confirms that explicit root, CLI and Tokzen license files exist.
It does **not** establish the legal validity or completeness of the abbreviated root
or CLI BUSL declarations, Tokzen's restricted-file BUSL declaration, legal authority,
or exhaustive approval of every dependency,
font, screenshot, trademark, fixture or video asset. The release gate must still run
the dependency/license and secret-history scans defined in the master plan.

| Mandatory confirmation | Owner | Evidence required | Status |
|---|---|---|---|
| Entrant is authorized to submit for YS Ventures LLC and use the Zintus name/marks | Human | signed/dated statement or internal approval reference | pending |
| Developer Tools entry is joined/registered | Human | Devpost confirmation or screenshot | pending |
| Optional OpenAI credit request is submitted before Jul 17 noon PT, or explicitly declined | Human | receipt or dated decline | pending |
| Private-repository + existing-BSL strategy is approved | Human | dated approval in this record | pending |
| Both judge accounts can access the private repository | Human | accepted invitation/access check from each account | pending |
| Fonts, screenshots, video/audio and demo-fixture assets are owned or licensed for submission | Human | asset/source checklist | pending |
| Third-party SDK use complies with its license and platform terms | Human + release audit | SBOM/license report and exceptions | pending D6 |

## Required human response

The following single response is sufficient to unblock the non-external portion of
D0-03:

```text
I confirm I am authorized to submit Zintus for YS Ventures LLC; approve keeping the
repository private under its existing BSL 1.1 license; and approve use of owned or
properly licensed Zintus branding/demo assets. Devpost registration: [confirmed/pending].
Credit request: [submitted/declined/pending]. Judge access: [confirmed/pending].
```

Do not mark D0-03 complete merely because the recommended option is documented.
Registration, credits and judge invitations are external human actions and their
receipts must be appended rather than inferred.

## Update rule

Append confirmations and receipts with dates. Never replace a pending or failed access
check with an unsupported success statement.
