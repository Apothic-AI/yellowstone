# FT32 consumer helper 2444cac1 — targeted guard corrections, NO APPLY YET

Parent fullsource+dryrun+fixture read. Accept chosenoperation, reject guardclaimsnotimplemented.
Fix ONLY listedpoints, localtemp tests/dryruns, no broadnewframework/Piagent/suites. Deliver updated
helperSHA+concisediff+READYthenSTOP. Nextparentrelease ONEconsumer first(w17:p6)beforeother5.

1. `ticks_now` mustcompare EXACTrow.process.starttime_ticks, notUTCroundedseconds. Liveherdrname/
   pane/tab/workspace/session mustmatchBOTHsnapshotANDholdcandidate; requireNONEMPTYsession,
   don'tskipcomparisonifcur_sessmissing. PI_PROFILE/PI_MODE/envinstance consistent. Checkagain
   immediatelybeforefilewrite AND immediatelybeforereload, plusholdrecordunchanged.
2. HoldguardcurrentartifactSHA aloneonlyfreezeshistory. Compareactualhold_record fileSHA against
   `hold_record_sha256` inartifact beforeeachaction; anynewheldrecorddriftrefuse. Keepliteral6allowlist
   exactIDs, nooverrideescape toarbitraryartifactapply (testoverridesdryrun/temp-only ifneeded).
3. Explicitprofiledefinitionmustdeclareprovider/model/thinking ALLmatchinginstance, fullprofilehash
   equalssnapshotglobalprofiles entry. Checkpi-profile.json bytes too. Sessionbranchstate/goal/mode
   snapshotUNREADABLEmustREFUSE (notprintitandproceed); absentgoalverifiedokay. Lastbranchleaf
   conventionvalidatedfrompackage enoughfortheseexact6; don'tinventruntimeunrecordedchoice.
4. Composer/modal mustreadjustintime beforewrite and before reload (authorizedreadonly), refuse
   nonemptycomposer/modal/ambiguousdisplay. Savebefore/aftervisiblecaptures. Noctrl-u dataerase.
   Humanhandreadpackettext notfutureexecutionguard. Standardtoolrechecksstatusnotcomposer.
5. Atomicwrite with exactfullJSON expectedpost = deepcopy(pre) minusONEqualifiedpin. Requirepost
   JSONEQUALexpected notjustremovedkey/count. RecheckCASaftertempcreatedBEFOREos.replace.
   Ownershippreservationfailure MUSTfail notsilentlypass; actualuid/gid/modecompareafter. fsyncparent.
   Savepostimage+structuredperlanereceipt with exactsettings/session/profile/globalhashes+identity.
6. Reload subprocess timeout/exception/nonzero/unverified + ANYpostcheckfailure -> same
   conditionalrollback path onlyifsettingsstillOURpostimage. Keepreceiptfailure anddon'toverwrite
   newerchange. Atomicrollback+verifybyteexactpreimage/metadata, no automaticotherlanerollback.
   Accountreloadmayhaveacceptedpostimagecacheeveniffilerolledback; recordwhetherrestorereload
   needed/verifiedusingexistingexactpane tool, doNOTsilentlyleavefile/cacheunknown.
7. Postcheck freshherdrselectedsessionpath/name/pane/tab/settledstatus+samepidticks, sessionbytes
   andentrycount unchanged, profile/plan/globalmode+goalconfig/profilesCONTENThashes unchanged,
   actualselectedbranchmodel/thinking/goals/modesunchanged, footer/composerpreserved. Expected
   currentmax remainsmax NOThigh; noresumeclaim becauseallsettled. Anynewruntimeunknownrefuse.
8. Remove `time.sleep(2)` fixedwait. Existingbroadcastverifiedreceipt is synchronization; ifneeded
   condition-drivenboundedpoll withoutsleep. No timerwaitfornothing.
9. `--apply` exits0onlystructuredreceiptallpreservationchecks+verifiedsinglepane reloadsuccess;
   no-opalreadyabsent muststillrecordreasonandnoexecutableadoptionclaim. Localfixturetest must
   exerciseactualsamewrite/rollbackfunctions (notseparatelookalikecode), includingCASchangedafter
   tempcreation, wrongsession/startticks/profile, untouchedotherpinvalue, rollbackskipsnewer.

No liveapplyforthesecorrections. Parentwillreadupdatedhelper and releasefirstconsumer. Don'tre-run
anotherfulllifecyclematrix; actualcanaryalreadyprovedexactmutation. KeepinstructionsEnglishreadable.
