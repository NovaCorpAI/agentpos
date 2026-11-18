# Scene for the Instaward week 1 video: the mandate demo, start to end.
#
# Needs the demo binary already built into the volume mounted at /target
# (`cargo test -p agentpos-mandate-policy --test mandate_demo --no-run`), and a `demo.sh`
# next to this tape that runs it. See contracts/README.md, "See it run".
Output scene-mandate.mp4
Set FontSize 19
Set Width 1920
Set Height 1080
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 32
Hide
Type "cd /vhs && chmod +x demo.sh && clear" Enter
Show
Sleep 1s
Type "./demo.sh   # the mandate, enforced by the contract"
Sleep 600ms
Enter
Sleep 62s
Sleep 6s
