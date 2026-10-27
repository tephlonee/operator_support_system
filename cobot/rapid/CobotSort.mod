MODULE CobotSort
  !*****************************************************************************************
  ! CobotSort: the cobot's part of sorting a cut sheet (PAI700 operator picking support).
  !
  ! The robot takes pieces off the cut sheet with a magnetic gripper and stacks them on the
  ! pallets standing at its spots (docks). Which pieces, where the magnet grips them and where
  ! each one goes is decided by the planner (src/cobot.js); this program only moves.
  !
  ! Two ways to get the tasks:
  !   bOnline = FALSE  the task list in CobotJob.mod (made by tools/cobot-export.mjs for one job).
  !                    No network needed: use this first in RobotStudio.
  !   bOnline = TRUE   ask the pipeline service for the next task over a socket, and report every
  !                    pick, place and failure back, so the operator's screen shows the progress.
  !                    Needs the socket option on the controller (IRC5: 616-1 PC Interface; check the
  !                    OmniCore option list) and the service running (npm start / npm run demo).
  !
  ! Needs, loaded in the same task:
  !   CobotCell.mod  the cell: tMagnet, wobjSheet, wobjDocks{}, pHome, robot ID, server address
  !   CobotJob.mod   the task list for offline mode (a placeholder is fine in online mode)
  ! and two I/O signals:
  !   doMagnet        digital output: magnet on (1) / off (0)
  !   diPartPresent   digital input: the gripper holds a part (in RobotStudio: the smart
  !                   component's sensor; on the real MG10: its part-detection output)
  !
  ! Protocol with the service (text lines ending in LF, one answer per request, every answer
  ! shorter than 80 characters, the longest string RAPID can hold):
  !   robot -> HELLO;<robot id>   service -> OK;<station>
  !   robot -> NEXT               service -> TASK;<id>;<dock>;<mass>;<cogX>;<cogY>;<cogZ>
  !                                          | WAIT | STOP | END
  !   robot -> PICK;<id>          service -> <x>;<y>;<z>;<angle>      (in wobjSheet)
  !   robot -> PLACE;<id>         service -> <x>;<y>;<z>;<angle>      (in the dock's work object)
  !   robot -> NAME;<id>          service -> <piece>;<part number>
  !   robot -> PICKED;<id>  PLACED;<id>  FAILED;<id>;<reason>          service -> OK
  ! Asking again for the same thing is harmless: after a lost connection the robot simply repeats
  ! its last question, and the service answers NEXT with the same task until it is reported.
  !
  ! Coordinates: mm and degrees. Pick targets are in wobjSheet (the sheet's 0,0 corner), place
  ! targets in the work object of their dock. A target's z is the TOP of the piece, where the
  ! magnet face touches. The angle turns the gripper about the vertical.
  !*****************************************************************************************

  RECORD cobottask
    num id;          ! task number in this job
    string uid;      ! the piece on the sheet, e.g. J14-07
    string partNo;   ! part number, e.g. 1045572
    num dock;        ! which pallet spot: index into wobjDocks (1 = A, 2 = B)
    num pickX;
    num pickY;
    num pickZ;
    num pickA;
    num placeX;
    num placeY;
    num placeZ;
    num placeA;
    num mass;        ! kg
    num cogX;        ! the piece's centre of gravity seen from the tool (mm, tool frame)
    num cogY;
    num cogZ;
  ENDRECORD

  ! Online (service) or offline (CobotJob.mod) tasks.
  PERS bool bOnline:=FALSE;

  ! Distances and speeds. Lift straight up out of the skeleton before moving sideways.
  CONST num nApproach:=60;     ! mm above a pick or place point for the approach
  CONST num nLift:=30;         ! mm lifted slowly, straight up, after gripping (plus the part's thickness)
  CONST num nSettle:=0.3;      ! s for the magnet to build up or let go
  CONST speeddata vTravel:=v500;
  CONST speeddata vNear:=v100;
  CONST speeddata vTouch:=v20;

  ! The payload while holding a piece, and the work object being placed on.
  PERS loaddata loadPart:=[0.001,[0,0,0.001],[1,0,0,0],0,0,0];
  PERS wobjdata wobjPlace:=[FALSE,TRUE,"",[[0,0,0],[1,0,0,0]],[[0,0,0],[1,0,0,0]]];

  VAR cobottask curTask;
  VAR bool bHaveTask:=FALSE;
  VAR num nNext:=1;
  VAR num nDone:=0;
  VAR num nFailed:=0;
  VAR bool bTaskOk:=FALSE;
  VAR bool bSockErr:=FALSE;
  VAR bool bAtHome:=FALSE;
  VAR socketdev sock;
  VAR string sLF:="";
  PERS string sLastMsg:="";

  PROC main()
    sLF:=ByteToStr(10\Char);
    nNext:=1;
    nDone:=0;
    nFailed:=0;
    ! Let the controller choose the arm configuration: the gripper turns a lot between pick and place.
    ConfJ\Off;
    ConfL\Off;
    SingArea\Wrist;
    SetDO doMagnet,0;
    GripLoad load0;
    MoveJ pHome,vTravel,fine,tMagnet\WObj:=wobj0;
    bAtHome:=TRUE;
    IF bOnline LinkOpen;
    NextTask;
    WHILE bHaveTask DO
      DoTask;
      NextTask;
    ENDWHILE
    MoveJ pHome,vTravel,fine,tMagnet\WObj:=wobj0;
    IF bOnline SocketClose sock;
    Say "done: "+NumToStr(nDone,0)+" placed, "+NumToStr(nFailed,0)+" handed back","";
  ENDPROC

  ! The next task into curTask; bHaveTask is FALSE when there is nothing more to do
  ! (offline: end of the list; online: the service says STOP or END).
  PROC NextTask()
    VAR string reply;
    VAR string kind;
    bHaveTask:=FALSE;
    IF NOT bOnline THEN
      IF nNext<=nTasks THEN
        curTask:=tasks{nNext};
        nNext:=nNext+1;
        bHaveTask:=TRUE;
      ENDIF
      RETURN;
    ENDIF
    WHILE TRUE DO
      Ask "NEXT",reply;
      kind:=Field(reply,1);
      IF kind="TASK" THEN
        ReadTask reply;
        IF bTaskOk THEN
          bHaveTask:=TRUE;
        ELSE
          Say "could not read this task:",reply;
        ENDIF
        RETURN;
      ELSEIF kind="WAIT" THEN
        ! Nothing for the cobot right now (the operator is still setting up, or between jobs):
        ! wait at home, out of the way, and ask again.
        IF NOT bAtHome THEN
          MoveJ pHome,vTravel,fine,tMagnet\WObj:=wobj0;
          bAtHome:=TRUE;
        ENDIF
        WaitTime 1;
      ELSE
        ! STOP (the operator pressed Stop cobot) or END.
        Say "service says "+kind,"";
        RETURN;
      ENDIF
    ENDWHILE
  ENDPROC

  ! One piece: pick it off the sheet, lift it straight out of the skeleton, put it on its stack.
  PROC DoTask()
    VAR robtarget pPick;
    VAR robtarget pPlace;
    pPick:=Target(curTask.pickX,curTask.pickY,curTask.pickZ,curTask.pickA);
    pPlace:=Target(curTask.placeX,curTask.placeY,curTask.placeZ,curTask.placeA);
    wobjPlace:=wobjDocks{curTask.dock};
    bAtHome:=FALSE;

    ! Pick
    MoveJ Offs(pPick,0,0,nApproach),vTravel,z20,tMagnet\WObj:=wobjSheet;
    MoveL pPick,vTouch,fine,tMagnet\WObj:=wobjSheet;
    SetDO doMagnet,1;
    WaitTime nSettle;
    IF DInput(diPartPresent)=0 THEN
      ! Nothing held: the piece is not where the job file says (moved, dropped, still attached).
      ! Do not search for it: hand it back to the operator and go on with the next one.
      SetDO doMagnet,0;
      MoveL Offs(pPick,0,0,nApproach),vNear,fine,tMagnet\WObj:=wobjSheet;
      Report "FAILED","no part detected";
      nFailed:=nFailed+1;
      RETURN;
    ENDIF
    loadPart.mass:=curTask.mass;
    loadPart.cog:=[curTask.cogX,curTask.cogY,curTask.cogZ];
    loadPart.aom:=[1,0,0,0];
    GripLoad loadPart;
    Report "PICKED","";
    MoveL Offs(pPick,0,0,curTask.pickZ+nLift),vTouch,fine,tMagnet\WObj:=wobjSheet;
    MoveL Offs(pPick,0,0,curTask.pickZ+nApproach),vNear,z10,tMagnet\WObj:=wobjSheet;

    ! Place: travel above the stack, come down slowly, let go.
    MoveJ Offs(pPlace,0,0,nApproach),vTravel,z20,tMagnet\WObj:=wobjPlace;
    MoveL Offs(pPlace,0,0,5),vNear,z1,tMagnet\WObj:=wobjPlace;
    MoveL pPlace,vTouch,fine,tMagnet\WObj:=wobjPlace;
    SetDO doMagnet,0;
    WaitTime nSettle;
    GripLoad load0;
    MoveL Offs(pPlace,0,0,nApproach),vNear,z20,tMagnet\WObj:=wobjPlace;
    Report "PLACED","";
    nDone:=nDone+1;
  ENDPROC

  ! A target with the gripper pointing straight down, turned by angle a (degrees) about the vertical.
  FUNC robtarget Target(num x,num y,num z,num a)
    VAR robtarget tgt;
    tgt.trans:=[x,y,z];
    tgt.rot:=OrientZYX(a,0,180);
    tgt.robconf:=[0,0,0,0];
    tgt.extax:=[9E9,9E9,9E9,9E9,9E9,9E9];
    RETURN tgt;
  ENDFUNC

  ! Tell the service (online) or the event log (offline) what happened to the current piece.
  PROC Report(string kind,string reason)
    VAR string msg;
    VAR string reply;
    msg:=kind+";"+NumToStr(curTask.id,0);
    IF reason<>"" msg:=msg+";"+reason;
    IF bOnline THEN
      Ask msg,reply;
    ELSE
      Say msg,curTask.uid+"  "+curTask.partNo;
    ENDIF
  ENDPROC

  ! A message for whoever watches the simulation. ErrWrite \I puts it in the controller's event
  ! log, which RobotStudio shows in its Output window, so no FlexPendant is needed; TPWrite also
  ! shows it on a FlexPendant if one is open. The last message is kept in sLastMsg.
  PROC Say(string line1,string line2)
    sLastMsg:=line1;
    TPWrite "Cobot: "+line1;
    IF line2<>"" THEN
      TPWrite "       "+line2;
      ErrWrite\I,"Cobot",line1\RL2:=line2;
    ELSE
      ErrWrite\I,"Cobot",line1;
    ENDIF
  ENDPROC

  ! ---------------- the link to the pipeline service ----------------

  PROC LinkOpen()
    VAR string reply;
    LinkReopen;
    Ask "HELLO;"+sRobotId,reply;
    Say "connected to the service, station:",reply;
  ENDPROC

  PROC LinkReopen()
    SocketClose sock;
    SocketCreate sock;
    SocketConnect sock,sServerIp,nServerPort\Time:=10;
  ERROR
    IF ERRNO=ERR_SOCK_TIMEOUT OR ERRNO=ERR_SOCK_CLOSED THEN
      Say "service not reachable, trying again","";
      WaitTime 3;
      SocketClose sock;
      SocketCreate sock;
      RETRY;
    ENDIF
  ENDPROC

  ! Send one line and wait for the one-line answer (returned without its line end). If the
  ! connection is lost, connect again and ask the same question again (up to 5 times), then
  ! give up with the answer "STOP".
  PROC Ask(string msg,INOUT string reply)
    VAR num tries:=0;
    WHILE tries<5 DO
      tries:=tries+1;
      bSockErr:=FALSE;
      reply:="";
      SocketSend sock\Str:=msg+sLF;
      IF NOT bSockErr SocketReceive sock\Str:=reply\Time:=30;
      IF NOT bSockErr THEN
        IF StrLen(reply)>0 THEN
          IF StrPart(reply,StrLen(reply),1)=sLF reply:=StrPart(reply,1,StrLen(reply)-1);
        ENDIF
        RETURN;
      ENDIF
      Say "lost the service, reconnecting","";
      WaitTime 2;
      LinkReopen;
    ENDWHILE
    Say "the service does not answer, stopping","";
    reply:="STOP";
  ERROR
    IF ERRNO=ERR_SOCK_TIMEOUT OR ERRNO=ERR_SOCK_CLOSED THEN
      bSockErr:=TRUE;
      TRYNEXT;
    ENDIF
  ENDPROC

  ! TASK;id;dock;mass;cogX;cogY;cogZ, then the pick and place poses and the name, each asked for
  ! on its own line (a whole task does not fit in one 80-character RAPID string).
  PROC ReadTask(string s)
    VAR string pose;
    VAR string name;
    bTaskOk:=TRUE;
    curTask.id:=NumField(s,2);
    curTask.dock:=NumField(s,3);
    curTask.mass:=NumField(s,4);
    curTask.cogX:=NumField(s,5);
    curTask.cogY:=NumField(s,6);
    curTask.cogZ:=NumField(s,7);
    Ask "PICK;"+NumToStr(curTask.id,0),pose;
    curTask.pickX:=NumField(pose,1);
    curTask.pickY:=NumField(pose,2);
    curTask.pickZ:=NumField(pose,3);
    curTask.pickA:=NumField(pose,4);
    Ask "PLACE;"+NumToStr(curTask.id,0),pose;
    curTask.placeX:=NumField(pose,1);
    curTask.placeY:=NumField(pose,2);
    curTask.placeZ:=NumField(pose,3);
    curTask.placeA:=NumField(pose,4);
    Ask "NAME;"+NumToStr(curTask.id,0),name;
    curTask.uid:=Field(name,1);
    curTask.partNo:=Field(name,2);
    IF curTask.dock<1 OR curTask.dock>Dim(wobjDocks,1) bTaskOk:=FALSE;
    IF curTask.mass<=0 bTaskOk:=FALSE;
  ENDPROC

  ! Field n (counting from 1) of a line separated by ";".
  FUNC string Field(string s,num n)
    VAR num pStart:=1;
    VAR num pEnd:=0;
    VAR num i:=1;
    IF StrLen(s)=0 RETURN "";
    WHILE i<n DO
      pStart:=StrFind(s,pStart,";")+1;
      IF pStart>StrLen(s) RETURN "";
      i:=i+1;
    ENDWHILE
    pEnd:=StrFind(s,pStart,";");
    IF pEnd=pStart RETURN "";
    RETURN StrPart(s,pStart,pEnd-pStart);
  ENDFUNC

  ! Field n as a number; a field that is not a number marks the task as unreadable.
  FUNC num NumField(string s,num n)
    VAR num v:=0;
    IF NOT StrToVal(Field(s,n),v) bTaskOk:=FALSE;
    RETURN v;
  ENDFUNC
ENDMODULE
