# India district and state boundaries

`india-admin.json.gz` is built by `scripts/build-india-admin.js` from the
geoBoundaries gbOpen release for India (commit `9469f09`, simplified geometry),
with district names updated to their current forms and a few source typos
corrected (see `RENAMED` in the script).

- **Districts (ADM2):** 2021 boundaries, Pathways Data Pvt. Ltd., from the
  Local Government Directory (lgdirectory.gov.in). Licensed under the
  [Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- **States (ADM1):** DataMeet India community, Election Commission of India.
  Licensed under [CC BY 2.5 India](https://creativecommons.org/licenses/by/2.5/in/).

Source: Runfola, D. et al. (2020) geoBoundaries: A global database of
political administrative boundaries. PLoS ONE 15(4): e0231866.
https://www.geoboundaries.org

**Known gaps.** Districts created after 2021 have no boundary of their own
and resolve to the district they were carved from — most visibly Andhra
Pradesh's 2022 reorganisation (13 districts into 26). Within a few hundred
metres of a border, the simplified outline can name the neighbouring district.
