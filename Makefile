.PHONY: serve serve-verbose build clean test install-pre-commit-hooks help

help:
	@echo "Available commands:"
	@echo "  make dnzn-init                 - Init DNZN Development"

dnzn-init:
	bash ../dnzn.common/scripts/dnzn-init.sh
