# Makefile for managing Docker Compose services

# Default target is help
.DEFAULT_GOAL := help

# Help menu target
help:
	@echo ""
	@echo "Available commands:"
	@echo "  make up          - Build and start all containers"
	@echo "  make down        - Stop and remove containers"
	@echo "  make logs        - Show backend logs"
	@echo "  make migrate     - Run Prisma migrations inside backend container"
	@echo "  make seed        - Seed initial data (optional)"
	@echo "  make restart     - Restart backend container only"
	@echo "  make clean       - Remove all volumes and containers"
	@echo ""

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f backend

migrate:
	docker compose exec backend npx prisma migrate dev --name init

restart:
	docker compose restart backend

clean:
	docker compose down -v

