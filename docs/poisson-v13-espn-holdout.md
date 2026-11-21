# 21 Kasım 2026 ESPN test kesiti

Ekim–Kasım verilerine göre daha yeni bir maç günü, model ve parametre seçimi bittikten sonra eklendi. Altı ligden 24 bitmiş ESPN fikstürü kullanıldı. Skor özeti her maçın başlangıç zamanı, ev/deplasman takım kimlikleri ve maç sonu skoruyla çapraz doğrulandı. İlk devre skoru ESPN'in birinci devre sütunundan alındı. İki devre toplamı maç sonu skoruyla eşleşti. Kaynak URL'leri, maç kimlikleri ve SHA-256 değerleri JSON raporlarındadır.

Modeller yalnızca Ocak–Haziran 2025 doğrulama döneminde seçildi. Geçmiş, Football-Data üzerinden 8 Kasım 2026'ya kadar gelir. 9–20 Kasım aralığının tam lig kapsamı yoktur. ESPN test tarihi önceki testlerde kullanılmadı. Aynı günün maçları birbirine veri sağlamaz.

[Maç sonu pazar sonuçları](poisson-v13-espn-holdout-ft.json) ve [ilk yarı pazar sonuçları](poisson-v13-espn-holdout-ht.json) Brier, log loss, ECE, örneklem ve kapsamı ayrı verir. Altı ligde ortak örneklem maç sonunda 20, ilk yarıda 21'dir. Lig başına 1–7 ortak maç bulunduğundan sonuçlar model kabulü için yeterli değildir.

Önceki Türkiye kesitinde v1.3, maç sonu ve ilk yarıda ev sahibi galibiyetleri ve beraberliklerde daha yüksek ortalama kayıp, deplasman galibiyetlerinde daha düşük kayıp verdi. Bir maç günü çıkarıldığında iki dönemde de farkın yönü değişebiliyor. Bu bulgu örneklem hassasiyetini gösterir. [Maç sonu](poisson-v13-turkey-diagnostics-ft.json) · [İlk yarı](poisson-v13-turkey-diagnostics-ht.json)
