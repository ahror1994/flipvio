import pymupdf

doc = pymupdf.open()
colors = [
    (0.12, 0.22, 0.35), (0.25, 0.15, 0.28), (0.15, 0.30, 0.22),
    (0.35, 0.25, 0.15), (0.18, 0.20, 0.32), (0.28, 0.28, 0.30)
]

for i in range(1, 25):
    page = doc.new_page(width=595.32, height=841.92)
    c = colors[(i - 1) % len(colors)]
    
    # Outer frame
    page.draw_rect(pymupdf.Rect(40, 40, 555.32, 801.92), color=c, width=4)
    # Header bar
    page.draw_rect(pymupdf.Rect(40, 40, 555.32, 110), fill=c, color=None)
    page.insert_text((60, 85), f"FLIPVIO DEMO MAGAZINE", fontsize=24, color=(1, 1, 1))
    
    # Title
    page.insert_text((60, 180), f"Страница {i:02d} — Раздел {((i-1)//4)+1}", fontsize=28, color=c)
    
    # Content block
    sample_text = (
        f"Это демонстрационная страница номер {i} каталога Flipvio.\n"
        "Flipvio обеспечивает 3D-изгиб страниц в браузере через WebGL2,\n"
        "акустический синтез звуков перелистывания через Web Audio API,\n"
        "адаптивный двухстраничный/одностраничный режим для десктопа и мобильных.\n"
        "Поддерживается масштабирование (zoom), миниатюры страниц и прямой переход по #p=N."
    )
    page.insert_textbox(pymupdf.Rect(60, 220, 535, 450), sample_text, fontsize=16, color=(0.1, 0.1, 0.1))
    
    # Decorative shapes
    page.draw_circle(pymupdf.Point(300, 580), 80, fill=c, color=None)
    page.insert_text((275, 590), f"{i}", fontsize=44, color=(1, 1, 1))
    
    # Footer
    page.insert_text((60, 780), f"Flipvio Digital Edition 2026 • https://flipvio.local", fontsize=12, color=(0.5, 0.5, 0.5))
    page.insert_text((490, 780), f"Стр. {i} / 24", fontsize=12, color=(0.5, 0.5, 0.5))

doc.save("c:/Users/ahror/Documents/antigravity/brave-pascal/flipvio/test-demo-24p.pdf")
doc.close()
print("Created test-demo-24p.pdf with 24 pages.")
