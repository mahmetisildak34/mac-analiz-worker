# Poisson v1.3 kabul deneyi

Model sıralaması, lig ve dönem bazında Ocak–Haziran 2025 ortak doğrulama örneklemindeki 1X2 log loss ile yapılır. Eşitlikte v1.2 korunur. Sıcaklık ve karışım adayları da aynı doğrulama döneminde değerlendirilir. Test verileri seçim fonksiyonuna girerse deney durur. Modeller günlük olarak önceki günler üzerinden güncellenir. İlk yarı yalnızca doğrulanmış devre skorlarına dayanır.

Altı lig tablosu daha önce kullanılmış OpenFootball test döneminin yeniden ölçümüdür. Süper Lig için daha önce denenmemiş Football-Data 2026/27 fikstürleri ayrı ölçülür. Burada Temmuz 2025–Haziran 2026 maçları çevrimiçi geçmiş olarak kullanılabilir, ancak model ve kalibrasyon seçimine katılmaz. İki kaynak tek bir veri kümesinde birleştirilmez.

| Dönem | Lig | Doğrulamada seçilen | Doğrulama n | Ortak test / toplam | v1.2 log loss | Seçilen log loss | Seçilen ECE |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| ft | tr.1 | window15 | 175 | 78/90 | 1.0430 | 1.0293 | 0.1127 |
| ft | en.1 | elo_calibrated | 186 | 365/398 | 1.0465 | 0.9981 | 0.0456 |
| ft | es.1 | elo_calibrated | 184 | 368/429 | 1.0256 | 0.9794 | 0.0453 |
| ft | de.1 | dixon_coles | 162 | 287/327 | 1.0410 | 0.9928 | 0.0457 |
| ft | it.1 | calibrated | 190 | 369/394 | 1.0168 | 0.9937 | 0.0707 |
| ft | fr.1 | elo_calibrated | 162 | 286/323 | 1.0187 | 0.9676 | 0.0368 |
| ht | tr.1 | elo_calibrated | 173 | 80/90 | 1.1710 | 1.0720 | 0.0920 |
| ht | en.1 | league_mix | 187 | 370/398 | 1.1335 | 1.0517 | 0.0380 |
| ht | es.1 | league_mix | 182 | 383/429 | 1.1691 | 1.0534 | 0.0291 |
| ht | de.1 | elo_calibrated | 159 | 309/327 | 1.2309 | 1.0431 | 0.0614 |
| ht | it.1 | league_mix | 175 | 375/394 | 1.3456 | 1.0697 | 0.0276 |
| ht | fr.1 | weighted10 | 162 | 304/323 | 1.1802 | 1.1296 | 0.0871 |
| tr-ft | tr.1 | elo_calibrated | 182 | 69/99 | 0.9951 | 0.9539 | 0.0944 |
| tr-ht | tr.1 | league_mix | 188 | 70/99 | 1.0887 | 1.0685 | 0.0342 |

JSON raporları her pazar için örneklem, Brier, log loss ve ECE içerir. Takım gol ortalamaları model beklentileridir.

- [ft makine okunur raporu](poisson-v13-acceptance-ft.json)
- [ht makine okunur raporu](poisson-v13-acceptance-ht.json)
- [tr-ft makine okunur raporu](poisson-v13-acceptance-tr-ft.json)
- [tr-ht makine okunur raporu](poisson-v13-acceptance-tr-ht.json)
