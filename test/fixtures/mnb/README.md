# Recorded MNB replies

Real responses of the MNB exchange-rate web service, recorded on 2026-10-27 (Tuesday,
14:55–15:35 Budapest time, after the day's publication) and used by `test/mnb/rates.test.ts`. Friday 2026-10-23 was a national
holiday, so there was no publication from 23 to 25 October.

Request (SOAP 1.1, plain HTTP: over HTTPS the same URL answers SOAP POSTs with an empty 404):

```sh
curl -X POST http://www.mnb.hu/arfolyamok.asmx \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: "http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetExchangeRates"' \
  --data-binary '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRates xmlns="http://www.mnb.hu/webservices/"><startDate>2026-10-11</startDate><endDate>2026-10-25</endDate><currencyNames>EUR</currencyNames></GetExchangeRates></soap:Body></soap:Envelope>'
```

| File | Request | Shows |
| --- | --- | --- |
| `GetExchangeRates_EUR_2026-10-09_2026-10-23.xml` | EUR, 10-09 … 10-23 | holiday → last publication 10-22 |
| `GetExchangeRates_EUR_2026-10-11_2026-10-25.xml` | EUR, 10-11 … 10-25 | holiday + weekend → 10-22, `366,52000` |
| `GetExchangeRates_EUR_2026-10-12_2026-10-26.xml` | EUR, 10-12 … 10-26 | `366,95000` (5 decimals) |
| `GetExchangeRates_EUR_2026-10-13_2026-10-27.xml` | EUR, 10-13 … 10-27 | `367,14` (2 decimals); mixed precision |
| `GetExchangeRates_EUR_2026-10-14_2026-10-28.xml` | EUR, 10-14 … 10-28 (ends tomorrow) | ends with the 10-27 publication |
| `GetExchangeRates_JPY_2026-10-11_2026-10-25.xml` | JPY, 10-11 … 10-25 | `unit="100"` |
| `GetExchangeRates_XYZ_2026-10-11_2026-10-25.xml` | XYZ (unknown) | bare `<Day date="…" />` elements, no `<Rate>` |
| `GetExchangeRates_EUR_2026-11-20_2026-12-04.xml` | EUR, future window | blank document `<MNBExchangeRates />` |
| `GetExchangeRates_EUR_2025-12-14_2025-12-28.xml` | EUR, 2025-12-14 … 12-28 | longest gap since 1990: last publication 12-23 |
| `GetExchangeRates_USD_1948-12-19_1949-01-02.xml` | USD, before the first publication (1949-01-03) | blank document `<MNBExchangeRates />` |
| `GetExchangeRates_GRD_1988-05-13_1988-05-27.xml` | GRD, 1988-05-13 … 05-27 | `0,00` placeholder on 05-27; every date listed twice (bare `<Day … />` + `<Day>` with the rate) |
| `GetExchangeRates_GRD_1988-05-18_1988-06-01.xml` | GRD, 1988-05-18 … 06-01 | the `0,00` placeholder inside the window |
| `GetCurrentExchangeRates_2026-10-27.xml` | GetCurrentExchangeRates | the 32 currently quoted currencies |
| `Fault_GetExchangeRates_invalid-date.xml` | startDate `2026-13-45` | HTTP 500 SOAP fault |

`getRate` never asks MNB about a date after today (Budapest): there is no official rate for it yet.
The future-window reply above only shows what MNB would answer.

Changes against the raw bytes: a final newline was added, and the .NET stack trace in the fault
was cut to its first three frames. Everything else is byte-for-byte as received. MNB currently
returns the same rate with a varying number of decimals (`363,13` or `363,13000`) from one
request to the next.
