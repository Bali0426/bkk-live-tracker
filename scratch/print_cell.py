with open('scratch/planovane_560.html', encoding='utf-8') as f:
    html = f.read()

p1 = html.find("<td class='bunka_vozu'")
p2 = html.find("<td class='bunka_vozu'", p1 + 20)
print(html[p1:p2])
