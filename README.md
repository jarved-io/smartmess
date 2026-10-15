# Next.js + Prisma + Postgres (Vercel-ready)

## 1. Database
Create a free Postgres database (Neon, Supabase, or Vercel Postgres) and copy its connection string.

## 2. Run locally
```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and ADMIN_KEY
npx prisma db push          # creates the Contact table
npm run dev
```

## 3. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 4. Deploy on Vercel
1. Import the GitHub repo on vercel.com (framework: Next.js, auto-detected).
2. Add environment variables: `DATABASE_URL`, `ADMIN_KEY`.
3. Deploy. Visit `/api/health` to confirm the database is connected.

## API
- `POST /api/contact` with `{ name, email, message }` saves a message.
- `GET /api/contact` with header `x-admin-key: <ADMIN_KEY>` lists messages.
- `GET /api/health` checks DB connectivity.
