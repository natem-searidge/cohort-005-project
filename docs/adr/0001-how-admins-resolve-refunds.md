---
status: accepted
---

# How admins resolve Refunds

Admins Approve or Decline Refunds by hand, on a review screen. We chose rules that keep each decision simple and impossible to dispute later. See `GLOSSARY.md` for the terms used here, and issue #1 for the PRD.

- **Refundable is judged once, when the learner asks, and never again at review.** A Refund that waits until after its Refund Window closes, or a learner who keeps watching after asking, does not change the outcome. Otherwise a slow review would decide the learner's Refund for them. What an admin judges is only whether one of the three decline reasons applies.
- **Only three decline reasons: Chargeback, Refund Abuse, Fraudulent Purchase.** The admin must pick one. Any other Refund is Approved. This stops admins declining for reasons that aren't in the policy.
- **The Declined email gives no reason.** It tells the learner to reply if they think it was a mistake. That way we never accuse a learner of fraud or abuse in writing.
- **Outcomes are final.** There is no undo. Undoing an Approve would mean giving access back and un-recording money already returned by hand. It would also conflict with the "never had a Refund" part of Refundable. A confirmation step guards against misclicks instead.
- **Approving records the decision; it does not move money.** There is no payment provider yet, so an admin returns the money by hand outside the platform. `amountRefunded` records what should have been returned (always the full amount paid), not proof that it was paid.
- **Approving deletes the enrollment but keeps lesson progress.** An Approved Refund ends access, as the glossary says. Keeping progress means a learner who buys again does not start over.

## Consequences

- Once a payment provider is added, Approve will need to start the payout itself. Then "the money was returned" and "the Refund was Approved" can stop being two separate facts.
- Because there's no fixed threshold for Refund Abuse, two admins may judge the same learner differently. Showing each learner's past Refunds across all courses on the review screen is the only aid they get.
