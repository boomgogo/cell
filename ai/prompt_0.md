

# Features

1. I'd like to give players a false sense of multiplayer function for now
    - add a country flag next to the cell of each player
    - NPCs get a random flag, probability depends on population per country in the world
    - the actual player gets a flag based on his IP address / country code
    - Since I'm deploying to Cloudflare, use the cdn-cgi/trace endpoint from Cloudflare
        - as a backup, use ipify.org or other popular alternatives

