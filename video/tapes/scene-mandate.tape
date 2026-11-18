# Scene for the Instaward week 1 video: the mandate demo, start to end.
#
# Runs in the charmbracelet/vhs image with two mounts:
#   /target  the cargo target folder, with the demo binary already built
#            (`cargo test -p agentpos-mandate-policy --test mandate_demo --no-run`)
#   /vhs     a folder with this tape and `mandate-demo.sh` copied as `demo.sh`
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
