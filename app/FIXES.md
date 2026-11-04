# Confirmed defect regressions

Each numbered block matches the read-only confirmed review. All listed tests run
in `swift test`; none needs a window, microphone permission, or a live mind.

## 1
- test: MindStartupTests.testExistingServiceWaitsWithoutReinstalling
- test: LauncherTests.testInterruptedSetupNeverPublishesHalfBuiltEnvironment

An already installed mind is allowed to finish starting. Its new environment is
published only after setup succeeds; interrupted setup is discarded.

## 2
- test: CreatureStateMachineTests.testSignInWithoutMindFindsBeforeStarting

The visible action finds a missing mind before starting sign-in.

## 3
- test: CreatureStateMachineTests.testOnlySuccessfulPollCanFeed
- test: MindProtocolRegressionTests.testCopilotAccessRequiredByHealthAndChat

Only a successful sign-in result followed by a ready mind ends hunger. Accounts
without Copilot get the right explanation and next step.

## 4
- test: CreatureStateMachineTests.testLoginFailuresHaveDistinctNextSteps
- test: CreatureStateMachineTests.testLostLoginRestartsOnceInsteadOfCallingItExpired

Cancelled, expired, missing, and unavailable-account sign-ins are distinct.
A lost sign-in is restarted once rather than misreported as an expired code.

## 5
- test: CreatureStateMachineTests.testNeedsAppearWithoutMindAndImmediatelyAfterSignIn

Local choices do not depend on a fed mind, and queued cards are projected
immediately when sign-in finishes.

## 6
- test: CreatureStateMachineTests.testRepeatSignInRestoresCodeAndCanCancel
- test: CreatureStateMachineTests.testShutdownCancelsSignInAndRestoresClipboard

Repeat presses re-show the saved code. Sign-in can be cancelled, and its work is
cancelled on exit.

## 7
- test: ClipboardLeaseTests.testSignInRestoresAllClipboardKinds
- test: ClipboardLeaseTests.testSignInDoesNotClobberSomethingCopiedMeanwhile

Temporary sign-in copying preserves every clipboard item and does not overwrite
something the owner copied meanwhile.

## 8
- test: CreatureStateMachineTests.testReleaseDuringPermissionNeverStartsEars
- test: CreatureDriverTests.testFakePermissionDelayCannotLeaveMicrophoneOpen

The press is recorded before asking permission. An early release cannot leave
the microphone open.

## 9
- test: AudioCaptureTests.testInvalidFormatsNeverInstallTap

Missing or invalid audio input is rejected before touching the microphone.

## 10
- test: AudioCaptureTests.testFailedStartRemovesTapAndCanRetry

An audio-start failure cleans up before another attempt.

## 11
- test: CreatureStateMachineTests.testOldRestCannotCollapseNewListenOrCard
- test: CreatureDriverTests.testInterruptingSpeechCancelsItsOldRestClock

Every turn has its own identity. Old waits are cancelled and cannot change a
newer listen or cover a waiting card.

## 12
- test: CreatureStateMachineTests.testOnlyOneQuestionCanBeInFlight
- test: VoiceTests.testOverlappingSpeechResumesOldWaiterAndIgnoresOldCallbacks

Questions cannot overlap. Speech completion belongs to its own utterance, and
interrupting speech releases the old waiter immediately.

## 13
- test: CreatureStateMachineTests.testBlockedStatesHaveDismissAndSettingActions

Blocked permissions are actionable cards with a setting button and a way to
return to rest.

## 14
- test: LoginItemTests.testOnlyApplicationsCopiesAreInstalled
- test: LoginItemTests.testMovedInstalledCopyRepairsMissingSavedPath

Only a real Applications copy can arrange its return at sign-in. Disposable
copies offer a move instead; an installed copy repairs an obsolete saved path.

## 15
- test: CreatureStateMachineTests.testFailedLookupRetriesWithClockAndStillHasWorkingButton

A slow mind is retried using the injected clock, and the visible retry action
works immediately.

## 16
- test: MindStartupTests.testLoadedServiceIsNotReinstalled

A loaded mind is never removed or reinstalled just because it is still starting.

## 17
- test: LoginItemTests.testUpdatingOwnJobNeverUnloadsIt

Updating our own saved sign-in setting never stops the app that is writing it.

## 18
- test: MindStartupTests.testApplePlaceholdersAreNeverExecutedWithoutTools
- test: MindStartupTests.testMissingToolsNeverInstallsKeepAlive
- test: LauncherTests.testMissingToolsPausesBeforeExitingInsteadOfRepeatingDialogs
- test: CreatureStateMachineTests.testMissingAppleToolsHasInstallActionWithoutRetryLoop

Prerequisites are checked before arranging automatic startup. The creature
offers Install, while the launcher waits before exiting if tools are absent.

## 19
- test: LoginItemTests.testUninstallStopsBothJobsAndRemovesSavedAppSetting

Removal stops both automatic helpers and includes both saved settings. The
menu also lets the owner stop automatic startup without removing the app.

## 20
- test: DoorWordsTests.testApprovalUsesPlainVerbWithoutProgramDetails

Approval cards use one shared table of plain actions, a readable caller name,
and its reason, without executable locations or internal numbers.

## 21
- test: DoorWordsTests.testTwinStreamAndPhoneUsePlainActionsNotCodes

Twin updates use the same action words. The note points to the working Object
button on the Mac; it does not invent a phone reply flow or ask for a short code.

## 22
- test: CreatureStateMachineTests.testUnreachableMindOffersWorkingRetry

An unreachable mind offers a working Find my mind action and a dismissal.

## 23
- test: CreatureStateMachineTests.testFailedSignInReattachesBeforeRetry

Sign-in failures explain what to do, and a repeat attempt finds the mind again.

## 24
- test: MindStartupTests.testServiceFailureNeverReportsSuccess
- test: CreatureStateMachineTests.testLoginSetupFailureShowsPlainRecovery

Startup failure is not reported as success. Details stay in the log while the
owner receives fixed, actionable words.

## 25
- test: CreatureMenuTests.testMenuActionsAreEnabledAndAdvancedHelperIsTuckedAway
- test: CreatureStateMachineTests.testNeedsYouAlwaysHasActionAndNoMachineWords

Shortcut help is enabled, advanced setup is under More, and external replies
are preserved verbatim. Only the creature's own lines use plain machinery words.

## 26
- test: CreatureStateMachineTests.testEveryPermissionHasCorrectSettingAndDismissal

Every permission card opens the matching setting and offers Not now.

## 27
- test: MindStartupTests.testLoadedServiceReceivesBothNewLauncherFilesWithoutBeingStopped
- test: MindStartupTests.testHealthyAttachedMindStillReceivesAnUpgradeWithoutToolsOrRestart

Upgrades atomically refresh both launcher files, even when the mind is already
healthy. Neither refresh unloads, kills, or reinstalls a running job.

## 28
- test: CreatureStateMachineTests.testAutomaticRetryNeverCancelsListeningOrDictation
- test: CreatureStateMachineTests.testAutomaticRetryPreservesUnansweredPermissionAndCallerCards
- test: CreatureStateMachineTests.testOldAutomaticRetryCannotCancelSignIn

Automatic lookup retries wait while a turn, sign-in, setup, or unanswered card
is active. Only an explicit Find my mind action resets those lanes.

## 29
- test: CreatureStateMachineTests.testReleaseBeforeDeniedPermissionStillOffersTheCorrectSetting
- test: CreatureStateMachineTests.testReleaseBeforeGrantedPermissionSaysHowToTryAgainWithoutOpeningEars

A release during the permission dialog never opens the microphone. Denial still
shows the correct setting; a grant explains how to press again.

## 30
- test: CreatureStateMachineTests.testTransientPollFailureKeepsTheCodeAndCanStillFinish
- test: CreatureStateMachineTests.testPollFailureBudgetIsBoundedAndResetsAfterAnAnswer

A transient poll failure keeps the code and sign-in alive. Ten consecutive
failures end the attempt with recovery words; an answer resets that budget.

## 31
- test: MindStartupTests.testLoadedOrInstalledServiceStillReportsMissingTools

An unresponsive existing service gets the same tools check as a fresh setup,
without being booted out or stuck in the long lookup wait.

## 32
- test: CreatureStateMachineTests.testLaterOnPermissionOrHelpDoesNotCancelSignIn
- test: CreatureStateMachineTests.testLaterOnSignInCardItselfStillCancelsAndRestoresClipboard

Later cancels sign-in only on its own code card, never on a permission or help
card that happens to be shown while signing in.

## 33
- test: CreatureStateMachineTests.testTransientChatFailureDoesNotMakeTheNextQuestionLoseItsMind

A failed answer retains the attached mind. The next question can try it again;
the existing explicit Find my mind action still works.

## 34
- test: CreatureStateMachineTests.testTranscriptMindTextVoiceAndHistoryAreVerbatim
- test: CreatureStateMachineTests.testCallerCardAndSelectedOptionRemainVerbatim
- test: VoiceTests.testActualUtterancePreservesTheMindsWords
- test: DoorWordsTests.testCallerReasonAndNameAreNotRewrittenAsCreatureCopy
- test: NeedsTests.testCreatureStreamBindingPreservesForeignUpdates

Transcripts, answers, spoken utterances, history, caller reasons, hook cards,
choices, and stream updates never pass through the creature's word replacer.

## 35
- test: StartupAdapterRegressionTests.testStopDisablesFutureStartsWithoutKillingEitherLiveJobAndConfirms
- test: StartupAdapterRegressionTests.testStoppedChoiceSurvivesReopeningAndMindLookupWithoutBootstrap
- test: StartupAdapterRegressionTests.testStoppedUnloadedMindStartsAsChildWithoutRestoringAutomaticStartup
- test: StartupAdapterRegressionTests.testStoppedChildIsNotDuplicatedByRetriesOrAnExplicitKeep
- test: StartupAdapterRegressionTests.testFailedExplicitKeepDoesNotUndoTheOwnersStoppedChoice
- test: CreatureStateMachineTests.testStartupChangesDoNotInterruptAnActiveTurnOrSignIn

Stop persists the owner's choice, disables and removes future starts, leaves
both live jobs alone, and confirms in a card. Manual reopening and mind lookup
honor the choice; a missing mind starts as a child instead of a saved service.

## 36
- test: CreatureStateMachineTests.testBusyHotkeyGivesFeedbackWithoutOverlappingOrChangingHistory
- test: MindClientTests.testCreatureChatTimeoutIsShorterThanTwoMinutes

A repeated hotkey explains that the previous question is still being answered.
It cannot start an overlapping ask, and the creature's request limit is 45 seconds.

## 37
- test: CreatureStateMachineTests.testFailedLoginDismissalStillExplainsHungerNotMissingMind
- test: CreatureStateMachineTests.testFailedSignInReattachesBeforeRetry

Sign-in failures retain the correct hunger state. A separate flag makes the
next Sign me in action reattach without falsely declaring the mind missing.

## 38
- test: CreatureStateMachineTests.testLoginSetupSuccessConfirmsBothReturnsAndHasDismissal

Startup setup has accurate working words and a visible Got it confirmation
that explains both the mind's readiness and the creature's return.

## 39
- test: StartupAdapterRegressionTests.testNoWindowIsNotMisreportedAsScreenPermission
- test: StartupAdapterRegressionTests.testScreenCaptureErrorStillOffersTheScreenPermissionSetting

The real screen adapter distinguishes an absent window from a capture failure.
Only the latter offers the Screen Recording permission setting.

## 40
- test: StartupAdapterRegressionTests.testMissingToolsDuringExplicitKeepOffersInstallInsteadOfTryAgain
- test: CreatureStateMachineTests.testLoginSetupSuccessConfirmsBothReturnsAndHasDismissal

Setup preserves the failure kind, so missing Apple tools offer Install instead
of an endless Try again loop. Success has a dismissable confirmation.

## 41
- test: DoctorGuidanceRegressionTests.testFirstPermissionRequestPointsToTheHotkeyNotAnEmptySettingsPane
- test: DoctorGuidanceRegressionTests.testDeniedPermissionsPointToSettingsAndRestrictedPermissionsToTheMacManager

The self-check distinguishes not-yet-requested permissions, denied permissions,
and restrictions imposed by the Mac's manager.

## 42
- test: DoctorGuidanceRegressionTests.testSignedInAccountWithoutCopilotGetsAnEnableCopilotStepNotAnotherFeeding

A signed-in account without Copilot has its own diagnosis and an Enable Copilot
next step, consistent with the creature's card.

## 43
- test: DoctorGuidanceRegressionTests.testStoppedLoginChoiceIsObservedWithoutNaggingOrChangingIt
- test: DoctorGuidanceRegressionTests.testEnvironmentOptOutIsAlsoAnIntentionalChoice
- test: DoctorGuidanceRegressionTests.testOptionalStartupAdviceSaysThisMacStartsNotGitHubSignIn

The self-check respects both the persisted startup choice and the environment
opt-out. Optional startup advice explicitly means this Mac, not GitHub sign-in.

## 44
- test: LoginItemTests.testCaskReopensTheUpdatedAppAfterRemovingItsJobs

The cask reopens the updated Applications copy after installation or upgrade,
so removing the old jobs cannot leave the creature permanently absent.

## 45
- test: StartupAdapterRegressionTests.testExplicitKeepAfterStopRestoresAndEnablesBothJobsIncludingOurOwn
- test: StartupAdapterRegressionTests.testExplicitKeepFromUnstableCopyOffersMoveAndNeverClaimsSuccess

Explicit Keep restores and enables both saved jobs, including our own live but
disabled job. An unstable app copy offers Move, never a false success.

## 46
- test: StartupAdapterRegressionTests.testStartupInstallErrorOffersRetryNotMoveAndRetryInstallsBoth

An automatic login-item installation error gets the working setup-retry card.
Only an actual unstable copy gets the Move to Applications card.

## 47
- test: LauncherTests.testFailedDependencyInstallBacksOffAndKeepsCacheAcrossRetries
- test: MindStartupTests.testKernelServiceThrottlesAnyUnexpectedRuntimeExit

Failed dependency setup cleans its temporary environment, preserves the pip
cache, and waits before exiting. New saved services also throttle runtime failures.
