# Agent Note: Long-conversation Fast review candidates

Status: implemented

English | [中文](2026-10-10-long-conversation-fast-review.zh.md)

## Problem

Fast review previously supplied only the most recent three active-path turns, branch pivots, explicit overrides, and off-path candidates. An early constraint in a long Chat Session still entered the provider request, but the review Agent could not see it when the user returned to that topic. The user had to find and exclude that message manually or run the more expensive Deep review.

## Decision

Fast routing now ranks older, still-included active-path messages by lexical overlap with the latest objective. For a high-ranked old message it also seeks a later, same-role active message with at least 0.2 lexical overlap to that old message. This brings a possible correction into the same review even if it paraphrases the current objective. At most eight distant active messages are admitted; mandatory nodes remain, and up to twelve slots are reserved for off-path candidates inside the 32-node packet. A zero-objective-overlap message can enter only as the later mate of a relevant anchor. The packet carries the existing graph links and active-path identity; routing does not edit the durable Context Plan. The review result still requires ordinary validation and user Apply.

The off-path slots first reserve one source from each off-path branch whose best candidate scores at least 40% of the top off-path candidate, with a minimum score of 0.05; remaining slots follow the original score order. This borrows candidate diversity from recommendation systems without lowering the 32-node bound or treating a repeated branch as several independent topics. It does not change source legality, user Excludes, or the classifier's choice.

Fast review accepts only request-level Include and Exclude proposals. Its prompt asks the model to leave Archive empty, and the validator removes Archive proposals even if the model returns them. Profile-owned Archive guidance applies to Deep review, which retains advisory Archive proposals with individual confirmation. The same structural checks still reject invalid node IDs and attempts to Archive Web or worker evidence.

## Alternatives considered

**Require Deep review for every old constraint.** This adds a slower tree inspection to the common long-chat path and leaves Fast blind to a frequent correction case.

**Exclude older active messages by graph age alone.** A deferred task or later correction can still need that evidence, so the router only surfaces candidates for review.

**Fill every off-path slot by score alone.** A long branch with repeated matching turns can hide another moderately relevant branch entirely, so the bounded packet reserves competitive branch coverage before filling by score.

**Let Fast propose durable Archive from a bounded packet.** A temporarily irrelevant branch is not necessarily obsolete. A frozen long-Web-chat packet elicited twelve Archive suggestions for temporary irrelevance after a one-sentence wording clarification, while still missing the needed request-level Exclude. Prompt wording alone does not enforce the lifecycle distinction.

## Consequences

A bounded unit case checks a forty-node active history: an old screen constraint and a later correction reach Fast review alongside recent turns and off-path nodes. A Loader-composed browser replay uses a thirty-turn Chat history. The user forks at an earlier topic, manually excludes an obsolete budget, then accepts the removal of an older screen constraint while keeping the current correction from the same fixed, keyless proposal. Each edit changes the next actual model request; the detour topic stays out of the active branch. This checks the review pipeline, not whether a live model identifies the correct obsolete constraint or whether the personal policy improves accuracy. Longer text, paraphrases, and unrelated matches remain retrieval risks.

A zero-API policy audit found that five exclusions of obsolete active-path chat messages made the old style rule suggest excluding both an older constraint and its later correction. Fast supplies at most four bounded, confirmed choices as weighted examples for the classifier, including explicit Keep-current choices from a completed multi-item review. The deterministic style layer no longer invents active-chat Excludes from source/path counts alone. It still permits a model-proposed, user-reviewed exclusion and retains source-specific advice for Web and worker evidence. The browser replay checks that the confirmed budget edit reaches the model-facing Fast packet; it does not measure whether a live model learns the preference.

Accepted multi-node Context recommendations now contribute at most two additional grouped examples, with no more than four choices per example. Each group preserves the joint Include/Exclude decision instead of presenting fractional selections as unrelated full-weight choices. Each choice includes its before/after selection state, and a group with any unchanged selected node is rejected. Only Client-marked, changed, complete reviewed proposals qualify; cases remain bounded and model-visible but do not alter the deterministic Plan or prove preference learning. Unit coverage checks extraction through inherited Session prefixes and the Fast packet bound.

Confirmed recommendation choices retain the bounded objective used by the review. A draft reviewed before send has no corresponding `user/message` yet; pairing it with the nearest logged user turn would mislabel preference cases and grouped plan examples. The confirmed event carries the objective, while unreviewed suggestions do not produce preference evidence. Older events continue to use the logged-turn fallback. Focused tests cover a draft-only Keep-current review and an accepted grouped plan example.

A constructed sibling-branch case checks that sixteen highly matching messages from one branch do not hide a moderately matching source from another branch. This checks candidate visibility on one fixture, not Context-choice quality or answer accuracy on natural long conversations.

Unit coverage checks that a Fast result containing both Exclude and Archive retains the Exclude and returns no Archive candidates, while Deep retains a structurally valid advisory Archive. This prevents the observed Fast misclassification from reaching its review card; it does not establish that Deep will judge obsolescence correctly.
