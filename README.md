# 🛍️ Hypnate Backend

**Hypnate** is the AI-powered e-commerce engine built for small and midsize online sellers.  
This backend provides the foundation for Hypnate’s seller platform — secure authentication, product & order management, and analytics — all running on a modern Node.js + Prisma stack.

---

## 🚀 Tech Stack

| Layer | Technology |
|-------|-------------|
| **Runtime** | Node.js + TypeScript |
| **Framework** | Express.js |
| **ORM** | Prisma |
| **Database** | PostgreSQL |
| **Cache / Queue (future)** | Redis |
| **Auth** | JWT (JSON Web Token) |
| **Containerization** | Docker / Docker Compose |

---
## Run with Docker:
# Build and start containers
make up

# View backend logs
make logs

# Run Prisma migrations
make migrate

# Stop and remove containers
make down


## Local Development:
# Install dependencies
npm install

# Run in dev mode
npm run dev

# Apply migrations
npx prisma migrate dev

# Open Prisma Studio (DB GUI)
npx prisma studio


## License

This backend is **proprietary software**. Copyright (c) 2026 Hypnate Solutions Private Limited. All rights reserved.

See the [LICENSE](LICENSE) file. No permission is granted to use, copy, modify, publish, distribute, sublicense, or sell this software without prior written permission from the copyright owner, except as expressly permitted by a separate written agreement. Third-party software included in or used by this project remains subject to its respective license terms.
