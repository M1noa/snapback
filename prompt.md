review everything in [@references](file:///Users/minoa/Documents/Projects/Snapback/references/) 


review all code, all sites, everything

and then lets come up with a PLAN.md to make the ultimate opensource discord restore bot



it should be fully configured (minus the token and owner id in .env) via discord bot slash commands

it should be made using https://github.com/OceanicJS/Oceanic and either typescript, bun, or similar

that or we make it in python or go.. python is slow and lazy, go is good but the optionsf or discord bots are kindve lacking

and then it should have a /setup command (only the owner or an admin can run) and htat will help you setup everyhting like setting the bots status, adding admins that can also run commands and manage the bot, backup your entire discord server, customize the bot by letting them upload a pfp and banner (gif supported), auto backup, auto restore, logging channel (for logs), and more

backing up should includ messages, channels, server settings, roles, what members have what roles, member list, onboarding, bans, timeouts/mutes, and more.. it should be a FULL and COMPLETE backup and when resotring it should allow chinisng what and wha tnot to restore.. for restoring emssagges it should fetch all users avatars and use webhooks to send messages using their nicknames and their avatars in all of hte channels with emssages up to 1k messages per channel (cna confiigure how many it backs up and how many it restores with a hard limit at 10k)

it should support multiple servers but really one owner/manager

it should have a small website part for verificaiton

oh yeah it needs to also have a verificatoin veature where hwen sentting up u pick the channel and the embed title, color, message, thumbnail, button text, button url (should be set to the url to access the bots website), etc and it will have the bot send that embed witht he button and it goto the oauth with the redirect beign set tot eh domin/url the owner gave 

oh yeah and the user cna pick which permissions it requires in the oauth, like weather it will join servers or not, access friends/blocked or not, etc


the website will check if the user oauth'd and then if it sees they did it will save tot eh database (configurable in the .env to use postgresql but by default it will just use a duckdb database file) the users info captured (like friends, wha toauths they have, ip adress caputres from website, email, user id, oauth time and last chcjeed time, and more)

and using slash commands the owner or an admin cna check at any time the info for a user and also do a refresh where it will check over eveyr user gaina dn show a summery and edi the emssage live of every user who removed the app and sutf fbut it will always keep the info captures like ip and email and stuff and only remove tha tif the owener runa  delete record command

the setup should inccldue sutff like eperial emsssages like weahter ht e mussages are viwable by tohers or not from the bot..

also it should hadnle resotirng users to a new server or any server with a selection menu where they seelct

it needs to be super detailed and polished.. primarily look over the new restore cord sourcecode from 2024 as it contains most of the things

the bot should be highly cvusomtizable, polished, easy to use, use hte new componenetsv2, be consistent, be userfriendly, and overall really good and usable


mafter reviewing allc od emake the plan.md and an AGENTS.md that has info like rules when writing codes/commands, consistency stuff, QoL things, to use all componenets possible (like selection menus and such), to always use componentsv2, and more


the bot is a ocmplete backup/restore bot for backing up entire dsicord servers and aestoring them aswell as resotring members

resotre should also have htings like restoring with roles using roles inte h last backup, auto delte old backups when their older than xyz age or theres zxyz amount of new backups, exporting backups or a full list of users info captured to json, and more...

the setup wizard shoudl aslo ha vehte dev make sur ehtye configured hte bot int eh discord developer panel correclty like with settings and redirect url adn how to seutpt eh redirect url using cloudflare utnnel

and if cloudfalre tunnnel is ebing used a thing to check it off/mark it as being sued so the ip capture knows to get the one formt eh header


stuff like this.. be detaile dand cover all abses be suepr detaile dwihte very feature inlcuding ones id idnt lsit/come up with but we should have

be suepr detaile daccount fo everything and every error and everything 

heres some things an llm suggested adding 
```
Implement a "Pull Counter" per Account:
Track the number of successful joins per day.
If an account hits the limit (e.g., 100-500 members), your system should flag that specific account as "Cooldown" or "Restricted" and stop attempts for that account immediately to avoid permanent suspension. (its common for discord to make limited accounts [accounts with warnings] to have a limited amount of pulls a day)

Do not guess errors; parse the JSON error body from the Discord API

also log user agent, time zone, audio devices, and other fingerpritng items

vpn detection and ip info via: country + asn data from db-ip lite; ip_type (hosting/residential) from ipverse/as-metadata (cc0)

be sure theres documentation/guides for the entire bot inlcuding setup process like making the bot and everyrhityghing needed
```

read code and plan now..

dispatch subgaents
