

# Issues

1. The rendering of the game has a flicker every 1~2 seconds



# Features

1. I'd like to give players a false sense of multiplayer function for now
    - add a country flag next to the cell of each player
    - NPCs get a random flag, probability depends on population per country in the world
    - the actual player gets a flag based on his IP address / country code
    - Since I'm deploying to Cloudflare, use the cdn-cgi/trace endpoint from Cloudflare
        - as a backup, use ipify.org or other popular alternatives

2. Add a "Fork me on Github" link in the player name / play overlay


# Q&A

- Can you try ?quality=0 on the machine where you see the flicker, and tell me your screen's refresh rate and browser? That would confirm the cause quickly.
    - chrome, 60Hz
    - setting quality=0 seems to fix the flicker
- ipify only returns an IP address, not a country, so it can't be the backup on its own. Are country.is and geojs.io OK instead?
    - Yes
- Is the pause design what you had in mind, and is github.com/boomgogo/cell the right link?
    - It is the correct link
    - let's NOT implement the esc pause screen
    - so just show on the player name / play overlay
