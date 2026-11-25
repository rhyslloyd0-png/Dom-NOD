# Staff Hub

Employee management portal for a multi-shop business: rota with automatic shift building, compliance,
leave and absence, training, checklists, notices and logins with seven access levels.
Node, Express and SQLite. No build step.

## Access levels

| Level | Sees | Can do |
|---|---|---|
| Staff | Own shifts, leave, training, details; their shop's rota (no pay); notices | Request holiday, update contact details, read notices |
| Supervisor | As staff, plus Heads Up | Run the daily checklists |
| Shop manager | Everything for their one shop | Build and fill the rota, team records, logins for their staff, approve leave, sign off training, compliance, shop notices |
| Area manager | Every shop in their area | As a manager in each, move people between shops, area notices, All shops view |
| Regional manager | Every shop in every area of their region | As area manager, region notices |
| Operations | The whole business | Staffing levels, courses, checklists, company notices, logins up to regional |
| Admin | The whole business | Regions, areas and shops, any login, audit log |

Nobody can change their own access, approve their own leave, sign off their own training or edit their own pay record.
Access is worked out from the structure on every request: shop -> area -> region.

## Rota: how shifts get built

1. **Forecast.** Enter hourly sales, or press *Predict sales* to fill them with the average of the same weekday over the last four weeks.
2. **Optimal levels.** Operations sets a table under Setup: hourly sales from £X needs N insiders and M drivers.
3. **Build shifts.** The rota turns each hour's requirement into open shifts (3 hour minimum, split above 9 hours, the first insider on is a manager shift).
   Shifts already given to people are kept and counted. *Build week* does every day from today.
4. **Fill.** The manager taps each open shift and picks someone. It refuses people who are on approved leave, already on an overlapping shift, or the wrong role.

Hours below the level needed are marked on the day rota.

## First-time setup

    npm ci
    cp .env.example .env                 # set SESSION_SECRET; SECURE_COOKIES=0 only for plain http
    npm run user -- yourname "Your Name" admin
    npm start

Sign in, open **Setup**, add regions, areas and shops, then load people:

    npm run import -- staff.csv

CSV header: `shop,first_name,last_name,job,job_title,hourly_rate,start_date,contract_hours,holiday_days,area,region`
(`job` is `manager`, `instore` or `driver`). Missing shops, areas and regions are created. Safe to re-run.

Managers then create each person's login from their record on the Team page. It shows a one-time temporary
password that must be changed at first sign in.

`npm run seed:demo -- "Shop name"` loads invented sample people into one shop for a look around. Do not run it on a shop holding real data: it wipes that shop's team first.

## Deploy

See `deploy/` for the systemd unit and nginx site. The app listens on 127.0.0.1 only and expects nginx with HTTPS in front.
Data lives in `data/hub.db`. Back that file up. Older databases upgrade themselves on start.

Not connected: live till figures on Heads Up need a data feed from the shop system.

Built by RSVX. Contact: rhys@rsvx.co.uk
