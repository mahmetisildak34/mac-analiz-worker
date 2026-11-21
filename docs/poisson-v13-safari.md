# Poisson v1.3 son test dönemi

Model ve parametreler Ocak–Haziran 2025 doğrulama maçlarıyla seçildi. Football-Data CSV dosyalarının özgün SHA-256 değerleri JSON raporlarında. Maç sonu ve devre skorları ayrı skor sütunlarından oluşturuldu. Eğitim veya doğrulamada sonraki maçlar kullanılmadı. Skorlar aynı gün oynanan maçların tahminlerine giremez. Önceki dönemlerden gelen skorlar kronolojik geçmişe eklenir.

Test başlangıcı önceden kullanılmamış OpenFootball dönemi sınırına göre 21 Eylül 2026 olarak belirlendi. Beş Avrupa liginin önceki skor arşivi 20 Eylül’de sona eriyordu. Yeni kaynak dosyalarında tamamlanmış ortak test maçları 9–10 Ekim ile 8 Kasım arasındadır. Türkiye satırları önceki 2026/27 test maçlarıyla örtüşür. Bu satırlar tutarlılık kontrolüdür.

| Dönem | Lig | Ortak / toplam | Seçim | v1.2 log loss | Seçilen log loss | Seçilen Brier | Seçilen ECE |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| ft | tr.1 | 32/45 | elo_calibrated | 0.8213 | 0.8270 | 0.4722 | 0.1949 |
| ft | en.1 | 39/50 | venue_strength | 1.1513 | 1.1014 | 0.6695 | 0.1477 |
| ft | es.1 | 41/50 | elo_calibrated | 0.9350 | 0.9333 | 0.5505 | 0.1468 |
| ft | de.1 | 26/45 | league_mix | 1.1264 | 1.0217 | 0.6133 | 0.1025 |
| ft | it.1 | 53/60 | calibrated | 0.9564 | 0.9058 | 0.5272 | 0.1150 |
| ft | fr.1 | 36/45 | elo_calibrated | 1.0044 | 0.9130 | 0.5423 | 0.1996 |
| ht | tr.1 | 33/45 | league_mix | 1.0398 | 1.0800 | 0.6570 | 0.1201 |
| ht | en.1 | 40/50 | league_mix | 2.0008 | 1.0662 | 0.6391 | 0.0537 |
| ht | es.1 | 41/50 | league_mix | 1.2126 | 1.0682 | 0.6463 | 0.0076 |
| ht | de.1 | 30/45 | league_mix | 1.0991 | 1.0323 | 0.6286 | 0.1429 |
| ht | it.1 | 55/60 | league_mix | 1.2937 | 1.0878 | 0.6614 | 0.0660 |
| ht | fr.1 | 36/45 | weighted10 | 1.0171 | 0.9945 | 0.6001 | 0.1205 |

[Maç sonu pazarları](poisson-v13-safari-ft.json) ve [ilk yarı pazarları](poisson-v13-safari-ht.json) 1X2, karşılıklı gol, alt/üst ve kesin skor dahil örneklem, kapsam, Brier, log loss ve ECE değerlerini içerir. Türkiye’de bu örtüşen kesitte doğrulamada seçilen yöntemler v1.2’den daha yüksek 1X2 log loss üretti. Test kümeleri küçük olduğundan v1.3 deneysel kalır.
