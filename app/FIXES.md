# Canonical defect regressions

Numbers and exact titles below follow `defects.tsv`, as printed by proof5.
The external detailed review files were not readable in this session; the
judge's complete canonical titles were available. Each entry names executable
scenario regressions, not an independently numbered inventory of improvements.
All tests run with `swift test`; no manual exceptions are used.

Later defects supersede two earlier expectations: Later hides a sign-in code
without cancelling it (61), and readable notices automatically compact after
eight seconds (68). Existing test methods are retained, with assertions updated
for those intentional changes. Real approval decisions are never auto-answered.

## 1
- defect: Startup bounces the launchd kernel whenever it is not yet answering, killing it mid-setup
- test: MindStartupTests.testExistingServiceWaitsWithoutReinstalling
- test: LauncherTests.testInterruptedSetupNeverPublishesHalfBuiltEnvironment

## 2
- defect: 'Sign me in' button is dead when the mind was never found
- test: CreatureStateMachineTests.testSignInWithoutMindFindsBeforeStarting

## 3
- defect: Fed detection uses /health, not the poll result, so an account without Copilot access is declared 'Fed' and every ask then says 'I couldn't reach my mind'
- test: CreatureStateMachineTests.testOnlySuccessfulPollCanFeed
- test: MindProtocolRegressionTests.testCopilotAccessRequiredByHealthAndChat

## 4
- defect: Every poll error is reported as 'That code expired'
- test: CreatureStateMachineTests.testLoginFailuresHaveDistinctNextSteps
- test: CreatureStateMachineTests.testLostLoginRestartsOnceInsteadOfCallingItExpired

## 5
- defect: While hungry or mind-less, every card is suppressed, so door callers and Claude Code hooks hang; after feeding, cards wait up to 30 s
- test: CreatureStateMachineTests.testNeedsAppearWithoutMindAndImmediatelyAfterSignIn

## 6
- defect: No cancellation of a running sign-in; a second 'Sign me in' silently does nothing and the code line can be lost
- test: CreatureStateMachineTests.testRepeatSignInRestoresCodeAndCanCancel
- test: CreatureStateMachineTests.testShutdownCancelsSignInAndRestoresClipboard

## 7
- defect: Sign-in overwrites the owner's clipboard and never restores it
- test: ClipboardLeaseTests.testSignInRestoresAllClipboardKinds
- test: ClipboardLeaseTests.testSignInDoesNotClobberSomethingCopiedMeanwhile

## 8
- defect: Key released during Ears.authorize() leaves the creature listening forever
- test: CreatureStateMachineTests.testReleaseDuringPermissionNeverStartsEars
- test: CreatureDriverTests.testFakePermissionDelayCannotLeaveMicrophoneOpen

## 9
- defect: No input device: installTap with a 0 Hz format throws an NSException and crash-loops under launchd
- test: AudioCaptureTests.testInvalidFormatsNeverInstallTap

## 10
- defect: engine.start() failure leaves the tap installed, so the next press crashes on a double tap
- test: AudioCaptureTests.testFailedStartRemovesTapAndCanRetry

## 11
- defect: rest() scheduled after speaking fires 2 s later regardless of state, collapsing an in-progress listen
- test: CreatureStateMachineTests.testOldRestCannotCollapseNewListenOrCard
- test: CreatureDriverTests.testInterruptingSpeechCancelsItsOldRestClock

## 12
- defect: Second question while the first is still thinking overlaps two asks and leaks a Voice continuation
- test: CreatureStateMachineTests.testOnlyOneQuestionCanBeInFlight
- test: VoiceTests.testOverlappingSpeechResumesOldWaiterAndIgnoresOldCallbacks

## 13
- defect: Denied-permission and ask-error branches park the notch expanded in needsYou with no way back
- test: CreatureStateMachineTests.testBlockedStatesHaveDismissAndSettingActions
- test: CreatureStateMachineTests.testUnreachableMindOffersWorkingRetry
- test: CreatureStateMachineTests.testEveryBriefTapOutcomeAutomaticallyCompacts

## 14
- defect: Login item pins whatever path the app happened to launch from (DMG, Gatekeeper translocation, dev dist/)
- test: LoginItemTests.testOnlyApplicationsCopiesAreInstalled
- test: LoginItemTests.testMovedInstalledCopyRepairsMissingSavedPath

## 15
- defect: After a failed mind lookup the card says 'Sign me in' but the button does nothing
- test: CreatureStateMachineTests.testFailedLookupRetriesWithClockAndStillHasWorkingButton

## 16
- defect: findMind reinstalls and boots out a kernel that is merely still starting
- test: MindStartupTests.testLoadedServiceIsNotReinstalled
- test: MindStartupTests.testExistingUnloadedServiceIsLoadedWithoutReplacingFiles

## 17
- defect: KeepAlive.install boots out its own launchd job when the plist content changes, killing itself before bootstrap
- test: LoginItemTests.testUpdatingOwnJobNeverUnloadsIt

## 18
- defect: Kernel run.sh needs python3 and git; on a fresh Mac launchd loops the Xcode CLT dialog every 10 s
- test: MindStartupTests.testApplePlaceholdersAreNeverExecutedWithoutTools
- test: MindStartupTests.testMissingToolsNeverInstallsKeepAlive
- test: LauncherTests.testMissingToolsPausesBeforeExitingInsteadOfRepeatingDialogs
- test: CreatureStateMachineTests.testMissingAppleToolsHasInstallActionWithoutRetryLoop

## 19
- defect: Uninstall via Homebrew leaves the app KeepAlive job and the kernel service running
- test: LoginItemTests.testUninstallStopsBothJobsAndRemovesSavedAppSetting

## 20
- defect: Door approval card shows raw door id, program path and PID to the owner
- test: DoorWordsTests.testApprovalUsesPlainVerbWithoutProgramDetails

## 21
- defect: Twin FYI line and phone note speak door ids and a code the owner must type back
- test: DoorWordsTests.testTwinStreamAndPhoneUsePlainActionsNotCodes

## 22
- defect: "I can't find my mind" and "I couldn't reach my mind" leave the owner with no action
- test: CreatureStateMachineTests.testUnreachableMindOffersWorkingRetry
- test: CreatureStateMachineTests.testFailedLookupRetriesWithClockAndStillHasWorkingButton

## 23
- defect: Sign-in failure line asks the owner a machinery question ("Is it running?")
- test: CreatureStateMachineTests.testFailedSignInReattachesBeforeRetry

## 24
- defect: Menu item "Keep my mind running at login" leaks raw error text on failure
- test: CreatureStateMachineTests.testLoginSetupFailureShowsPlainRecovery
- test: MindStartupTests.testServiceFailureNeverReportsSuccess

## 25
- defect: Menu titles and the Full Disk Access card use machinery words ("Full Disk Access", "Claude Code") and a blank-action menu header
- test: CreatureMenuTests.testMenuActionsAreEnabledAndAdvancedHelperIsTuckedAway
- test: CreatureStateMachineTests.testEveryPermissionHasCorrectSettingAndDismissal
- test: CreatureStateMachineTests.testNeedsYouAlwaysHasActionAndNoMachineWords

## 26
- defect: Permission-denied lines name System Settings panes but offer no button, unlike the Full Disk Access card
- test: CreatureStateMachineTests.testEveryPermissionHasCorrectSettingAndDismissal

## 27
- defect: Existing installs never receive the new run.sh (atomic venv, tools check); prepareService never refreshes the launcher copy
- test: MindStartupTests.testLoadedServiceReceivesBothNewLauncherFilesWithoutBeingStopped
- test: MindStartupTests.testHealthyAttachedMindStillReceivesAnUpgradeWithoutToolsOrRestart

## 28
- defect: 30 s automatic mind retry wipes an in-progress dictation/listen and any permission card
- test: CreatureStateMachineTests.testAutomaticRetryNeverCancelsListeningOrDictation
- test: CreatureStateMachineTests.testAutomaticRetryPreservesUnansweredPermissionAndCallerCards
- test: CreatureStateMachineTests.testOldAutomaticRetryCannotCancelSignIn

## 29
- defect: Release during the first permission dialog hides a denied-permission card and gives no feedback on grant
- test: CreatureStateMachineTests.testReleaseBeforeDeniedPermissionStillOffersTheCorrectSetting
- test: CreatureStateMachineTests.testReleaseBeforeGrantedPermissionSaysHowToTryAgainWithoutOpeningEars

## 30
- defect: One failed /login/poll now aborts the sign-in with 'I lost the sign-in page' and marks the mind missing (old code tolerated it)
- test: CreatureStateMachineTests.testTransientPollFailureKeepsTheCodeAndCanStillFinish
- test: CreatureStateMachineTests.testPollFailureBudgetIsBoundedAndResetsAfterAnAnswer

## 31
- defect: Defect 18 fix never fires for an already-installed kernel service: tools check is skipped when the job is loaded or the plist exists
- test: MindStartupTests.testLoadedOrInstalledServiceStillReportsMissingTools

## 32
- defect: 'Later' on any creature card (mic/speech permission, help, move, retry) silently cancels an in-progress sign-in
- test: CreatureStateMachineTests.testLaterOnPermissionOrHelpDoesNotCancelSignIn

## 33
- defect: One transient chat error demotes a fed, reachable mind to 'missing', so the next spoken question is answered with 'I can't find my mind'
- test: CreatureStateMachineTests.testTransientChatFailureDoesNotMakeTheNextQuestionLoseItsMind

## 34
- defect: OwnerWords.plain rewrites the mind's answers and the owner's own words; the defect-25 test asserts the corruption
- test: CreatureStateMachineTests.testTranscriptMindTextVoiceAndHistoryAreVerbatim
- test: CreatureStateMachineTests.testCallerCardAndSelectedOptionRemainVerbatim
- test: VoiceTests.testActualUtterancePreservesTheMindsWords
- test: DoorWordsTests.testCallerReasonAndNameAreNotRewrittenAsCreatureCopy
- test: NeedsTests.testCreatureStreamBindingPreservesForeignUpdates

## 35
- defect: "Stop starting at login" boots out the running mind and the app itself, and the next question silently reinstalls the service
- test: StartupAdapterRegressionTests.testStopDisablesFutureStartsWithoutKillingEitherLiveJobAndConfirms
- test: StartupAdapterRegressionTests.testStoppedChoiceSurvivesReopeningAndMindLookupWithoutBootstrap
- test: StartupAdapterRegressionTests.testStoppedUnloadedMindStartsAsChildWithoutRestoringAutomaticStartup
- test: StartupAdapterRegressionTests.testStoppedChildIsNotDuplicatedByRetriesOrAnExplicitKeep
- test: StartupAdapterRegressionTests.testFailedExplicitKeepDoesNotUndoTheOwnersStoppedChoice
- test: CreatureStateMachineTests.testStartupChangesDoNotInterruptAnActiveTurnOrSignIn

## 36
- defect: While a question is in flight the hotkey is swallowed with no feedback for up to the 120 s chat timeout
- test: CreatureStateMachineTests.testBusyHotkeyGivesFeedbackWithoutOverlappingOrChangingHistory
- test: MindClientTests.testCreatureChatTimeoutIsShorterThanTwoMinutes

## 37
- defect: failLogin marks a reachable, hungry mind as missing, so the next ask tells the owner "I can't find my mind"
- test: CreatureStateMachineTests.testFailedLoginDismissalStillExplainsHungerNotMissingMind
- test: CreatureStateMachineTests.testFailedSignInReattachesBeforeRetry

## 38
- defect: Defect 24 success path shows nothing, and its working line describes the wrong thing
- test: CreatureStateMachineTests.testLoginSetupSuccessConfirmsBothReturnsAndHasDismissal

## 39
- defect: Every screen-read failure, including 'no front window', is reported as a missing Screen Recording permission
- test: StartupAdapterRegressionTests.testNoWindowIsNotMisreportedAsScreenPermission
- test: StartupAdapterRegressionTests.testScreenCaptureErrorStillOffersTheScreenPermissionSetting

## 40
- defect: 'Keep my mind ready when I sign in' says 'Try again' forever when Apple's tools are missing, and gives no feedback at all on success
- test: StartupAdapterRegressionTests.testMissingToolsDuringExplicitKeepOffersInstallInsteadOfTryAgain
- test: CreatureStateMachineTests.testLoginSetupSuccessConfirmsBothReturnsAndHasDismissal

## 41
- defect: Doctor tells an owner who has not yet been asked for mic/speech permission to allow it in System Settings, where the app is not listed
- test: DoctorGuidanceRegressionTests.testFirstPermissionRequestPointsToTheHotkeyNotAnEmptySettingsPane
- test: DoctorGuidanceRegressionTests.testDeniedPermissionsPointToSettingsAndRestrictedPermissionsToTheMacManager

## 42
- defect: Doctor reports a signed-in account without Copilot as "hungry" and tells the owner to sign in again
- test: DoctorGuidanceRegressionTests.testSignedInAccountWithoutCopilotGetsAnEnableCopilotStepNotAnotherFeeding

## 43
- defect: Fed doctor next step "so I can return when you sign in" reads as the GitHub sign-in and nags owners who chose "Stop starting at login"
- test: DoctorGuidanceRegressionTests.testStoppedLoginChoiceIsObservedWithoutNaggingOrChangingIt
- test: DoctorGuidanceRegressionTests.testEnvironmentOptOutIsAlsoAnIntentionalChoice
- test: DoctorGuidanceRegressionTests.testOptionalStartupAdviceSaysThisMacStartsNotGitHubSignIn

## 44
- defect: Cask `uninstall launchctl:` runs on every `brew upgrade`: creature killed, both plists deleted, never reopened (defect 17's outcome reintroduced)
- test: LoginItemTests.testCaskReopensTheUpdatedAppAfterRemovingItsJobs

## 45
- defect: 'Keep my mind ready when I sign in' never reinstalls the app's own login item; reports success while the creature will not return
- test: StartupAdapterRegressionTests.testExplicitKeepAfterStopRestoresAndEnablesBothJobsIncludingOurOwn
- test: StartupAdapterRegressionTests.testExplicitKeepFromUnstableCopyOffersMoveAndNeverClaimsSuccess

## 46
- defect: Any LoginItem.install() error is shown as 'Move OpenRappter to your Applications folder' even when it is already there
- test: StartupAdapterRegressionTests.testStartupInstallErrorOffersRetryNotMoveAndRetryInstallsBoth

## 47
- defect: run.sh: a failed pip install exits immediately under KeepAlive, rebuilding a venv from scratch every ~10 s
- test: LauncherTests.testFailedDependencyInstallBacksOffAndKeepsCacheAcrossRetries
- test: MindStartupTests.testKernelServiceThrottlesAnyUnexpectedRuntimeExit

## 48
- defect: Defect 29 grant path still gives no visible feedback: the rest line only renders in the expanded notch, which this path compacts
- test: CreatureStateMachineTests.testEarlyPermissionReleaseKeepsTheTryAgainLineExpanded
- test: CreatureDriverTests.testRealDriverCompactsBothPermissionTapAndEmptyTranscriptAtEightSeconds

## 49
- defect: Stop starting at login cancels the automatic mind retry and never re-arms it
- test: CreatureStateMachineTests.testStopStartupRearmsAMissingMindsAutomaticRetry

## 50
- defect: Defect 27 refresh now runs on the healthy attach path and can turn an attached mind into 'I can't find my mind'
- test: MindStartupTests.testFailedLauncherRefreshCannotBreakAHealthyAttachment
- test: MindStartupTests.testHealthyAttachedMindStillReceivesAnUpgradeWithoutToolsOrRestart

## 51
- defect: After Keep hits missing tools, the Install card's 'then choose Find my mind' never completes the Keep request when startup was stopped
- test: StartupAdapterRegressionTests.testFindActionAfterInstallingToolsFinishesTheOriginalKeepRequest

## 52
- defect: 'Keep my mind ready' failure demotes a reachable, answering mind to toolsMissing and refuses every question
- test: CreatureStateMachineTests.testFailedKeepNeverDemotesAnAnsweringMindEvenAfterNoticeExpires

## 53
- defect: Busy-hotkey line says 'Still thinking about your last question.' during dictation typing and screen reading
- test: CreatureStateMachineTests.testBusyDictationDescribesTypingAndPreservesTheActualWords
- test: CreatureStateMachineTests.testBusyScreenReadingDescribesTheActualStageWithoutStartingAnotherAsk

## 54
- defect: First card a fresh owner ever sees is a Full Disk Access request; it outranks the sign-in code card and returns on every launch
- test: CreatureStateMachineTests.testFreshOwnerSeesSignInInsteadOfTheTextsPermission
- test: CreatureStateMachineTests.testOptionalPermissionsCannotCoverAnActiveSignInCode
- test: OwnerViewRegressionTests.testActualSignInCardIsRenderedBeforeAnOptionalPermission
- test: NeedsTests.testDeferredTextsPermissionDoesNotReturnOnTheNextLaunch
- test: NeedsTests.testAutomaticPermissionDeferralPersistsWithoutAnsweringIt

## 55
- defect: There is no way to quit the creature
- test: CreatureStateMachineTests.testMenuHasAPlainEnabledQuitAction
- test: CreatureStateMachineTests.testSpokenSleepQuitsWithoutAskingTheMind
- test: CreatureStateMachineTests.testTypedSleepQuitsWithoutAskingTheMind
- test: OwnerViewRegressionTests.testTypingGoToSleepInTheActualFieldUsesTheQuitRoute
- test: StartupAdapterRegressionTests.testQuitAdapterCleansUpAndUsesTheRealTerminationBoundary
- test: LoginItemTests.testQuitUnloadsOnlyTheLiveCreatureAndPreservesFutureStarts

## 56
- defect: A speech-recognition failure is indistinguishable from silence, and a recognizer that is unavailable is reported as a missing microphone
- test: SpeechRecognitionRegressionTests.testRecognitionFailureIsNotSilenceAndNextCaptureCanStillSucceed
- test: SpeechRecognitionRegressionTests.testUnavailableRecognizerNeverTouchesTheMicrophoneOrClaimsItIsMissing
- test: SpeechRecognitionRegressionTests.testMacAdapterReportsRecognitionFailureInsteadOfAnEmptyTranscript

## 57
- defect: Dictation permission card opens a pane where OpenRappter is not listed, because the app never asks for Accessibility
- test: StartupAdapterRegressionTests.testDictationActuallyRequestsAccessibilityBeforeShowingItsSetting
- test: StartupAdapterRegressionTests.testAllowedDictationDoesNotLoseItsWordsOrRequestUnrelatedPermissions

## 58
- defect: An expired sign-in code is reported as 'GitHub couldn't finish signing you in' because the kernel reports expiry as status error
- test: MindProtocolRegressionTests.testKernelErrorStatusWithExpiredTokenGetsFreshCodeGuidance

## 59
- defect: A question asked while the mind is still being found is dropped with no acknowledgement
- test: CreatureStateMachineTests.testTypedAndSpokenQuestionsDuringLookupExplainThatTheyWereNotSent

## 60
- defect: 'Move OpenRappter to your Applications folder, then open it there' cannot be completed: the Applications copy blocks forever behind the still-running DMG copy
- test: CreatureHandoffTests.testApplicationsCopyRetiresDMGOrTranslocatedCopyInsteadOfWaitingForever
- test: CreatureHandoffTests.testUnresponsiveDisposableCopyHasABoundedHandoff
- test: CreatureHandoffTests.testHandoffNeverTerminatesAnInstalledOrUnidentifiedPeer

## 61
- defect: 'Later' on the sign-in code card silently cancels the sign-in and puts the old clipboard back, so the owner pastes the wrong thing on GitHub
- test: CreatureStateMachineTests.testLaterHidesCodeButKeepsPollingAndClipboardUntilExplicitCancellation

## 62
- defect: First-time install: after 4 minutes the creature says 'I can't find my mind' while the mind is still being built, and the automatic retry is starved by the Full Disk Access card
- test: MindStartupTests.testFirstSetupCanTakeMoreThanFourMinutesWithoutClaimingTheMindIsMissing
- test: CreatureStateMachineTests.testDeferredOptionalPermissionCannotStopAutomaticMindRecovery

## 63
- defect: Successful sign-in gives the owner no confirmation: the card vanishes and the notch compacts with no words
- test: CreatureStateMachineTests.testSuccessfulSignInConfirmsReadablyThenCompactsWithoutAClick

## 64
- defect: Screen Recording card loops: after the owner allows it, macOS still needs a relaunch, and the card never says so
- test: CreatureStateMachineTests.testScreenPermissionExplainsTheRequiredRelaunchAndRetry

## 65
- defect: Card titles longer than two lines are truncated in the notch, cutting off the instruction the owner needs
- test: OwnerViewRegressionTests.testLongCardTitleAndContextHaveFullRenderedHeight

## 66
- defect: Defect 52 is unfixed: a failed 'Keep my mind ready' demotes a ready mind to toolsMissing and refuses every question
- test: CreatureStateMachineTests.testFailedKeepNeverDemotesAnAnsweringMindEvenAfterNoticeExpires

## 67
- defect: Defects 53 and 57 are unfixed: wrong busy line during dictation, and the dictation permission is never requested
- test: CreatureStateMachineTests.testBusyDictationDescribesTypingAndPreservesTheActualWords
- test: StartupAdapterRegressionTests.testDictationActuallyRequestsAccessibilityBeforeShowingItsSetting

## 68
- defect: Every finished answer and every brief key tap now leaves the notch stuck open until the owner clicks Got it
- test: CreatureDriverTests.testRealDriverCompactsAnAnswerAtEightSecondsAfterSettlingWithoutAClick
- test: CreatureDriverTests.testRealDriverCompactsBothPermissionTapAndEmptyTranscriptAtEightSeconds
- test: CreatureStateMachineTests.testEveryBriefTapOutcomeAutomaticallyCompacts
- test: CreatureStateMachineTests.testDictationAndSetupNoticesAlsoExpireWithoutAClick
- test: CreatureStateMachineTests.testOldNoticeTimeoutCannotCollapseANewListenOrANewerNotice
- test: CreatureStateMachineTests.testAutomaticNoticeDismissalNeverAnswersOrHidesACallersDecision
- test: CreatureStateMachineTests.testOptionalCardsCannotKeepAnExpiredAnswerExpanded
- test: CreatureStateMachineTests.testUnsentDraftSuspendsAutomaticCompactingUntilItIsCleared
- test: OwnerViewRegressionTests.testActualTypingPausesCompactingAndKeepsTheDraftAcrossViewReplacement

## 69
- defect: A question typed or spoken before the mind is ready disappears with no explanation
- test: CreatureStateMachineTests.testTypedAndSpokenQuestionsDuringLookupExplainThatTheyWereNotSent
- test: CreatureStateMachineTests.testQuestionsBeforeSignInOrWithAMissingMindHaveAnExplanationAndRecovery
