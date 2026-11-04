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
cross the same plain-word boundary as the creature's own lines.

## 26
- test: CreatureStateMachineTests.testEveryPermissionHasCorrectSettingAndDismissal

Every permission card opens the matching setting and offers Not now.
