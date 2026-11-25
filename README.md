# Staff Hub

Store operations hub: compliance tracker, staff notices, Heads Up board and a day rota builder.
Node, Express and SQLite. No build step.

## Screens

- **Compliance**: right to work, job and additional documents that have expired or fall due within 8 weeks, missing contracts, registers, policies and certificates.
- **Heads Up**: who is on now, rota hours, labour % and forecast for today, with insider and driver charts. Live till figures show as empty until a data feed is added.
- **Rota**: day plan from 10am to 1am, shifts per person, hours per hour, forecast sales and labour % by group and for the week.
- **Notices**: staff read and acknowledge; managers publish.
- **Team**: people, rota role, pay rate, contract flag, documents.

Roles: `staff` sees Heads Up, Rota and Notices with no pay data. `manager` runs their own store. `admin` sees every store.

## Run locally

    npm ci
    cp .env.example .env        # set SESSION_SECRET, set SECURE_COOKIES=0 for plain http
    npm run user -- yourname "Your Name" admin "Haverfordwest"
    npm run seed:demo -- "Haverfordwest"     # optional, invented sample people
    npm start

Open http://localhost:3400

## Deploy

See `deploy/` for the systemd unit and nginx site. The app listens on 127.0.0.1 only and expects nginx with HTTPS in front.

Data lives in `data/hub.db`. Back that file up.

Built by RSVX. Contact: rhys@rsvx.co.uk
