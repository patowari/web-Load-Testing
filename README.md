# Open-Source k6 Load Testing Template

A practical, contributor-friendly load testing project built with [k6](https://k6.io/).

This repository helps teams and individuals validate reliability, performance, and scalability with realistic traffic patterns, measurable thresholds, and clear pass/fail outcomes.
<img width="846" height="536" alt="image" src="https://github.com/user-attachments/assets/1fcca609-1c9e-4f00-acf0-b749e59bccbb" />

## Goals

- Provide a ready-to-run k6 test baseline
- Model real traffic behavior (not only single-endpoint tests)
- Catch regressions early with threshold-based quality gates
- Make performance testing easy for open-source contributors

## What This Test Covers

The script in [load_test.js](load_test.js) includes:

- Full page load checks across common routes
- API endpoint checks (health, assets, and REST-style routes)
- POST request simulation and mixed user actions
- Custom metrics for latency, failures, slow requests, and timeouts

## Load Profile

The default staged model simulates growth, pressure, and recovery:

1. Warm-up: 30s ramp to 50 VUs
2. Normal load: 2m at 100 VUs
3. Heavy load: 2m at 200 VUs
4. Spike: 30s burst to 350 VUs
5. Sustained: 2m at 200 VUs
6. Recovery: 1m ramp down to 0

## Metrics and Thresholds

This project uses both k6 built-in metrics and custom metrics:

- Request latency percentiles (P95/P99)
- API and page response trends
- Error counters and error-rate tracking
- Slow-request and timeout counters

Thresholds are configured to fail the run when user experience or service reliability degrades.

## Quick Start

### 1. Install k6

Verify installation:

```bash
k6 version
```

### 2. Run the test

From the repository root:

```bash
k6 run ./load_test.js
```

### 3. Review output

Check:

- threshold pass/fail summary
- latency distribution (`avg`, `p(95)`, `p(99)`)
- failure behavior during heavy and spike stages

## Contributing

Contributions are welcome from everyone.

1. Fork this repository
2. Create a feature branch
3. Make focused changes with clear commit messages
4. Open a pull request with a short explanation and test evidence

Please keep contributions respectful, documented, and aligned with performance testing best practices.

## Roadmap Ideas

- Add CI execution with GitHub Actions
- Add environment-based config (`dev`, `staging`, `prod`)
- Export metrics to Grafana/InfluxDB
- Add token-based authenticated scenarios
- Add endpoint-specific SLOs and reporting

## Project Structure

```text
.
├── load_test.js
└── README.md
```

## License

Choose an open-source license (MIT is a common default) and add a `LICENSE` file.

## Disclaimer

Run load tests only against systems you own or are explicitly authorized to test.
