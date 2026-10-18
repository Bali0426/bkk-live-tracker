import asyncio
import sys
sys.path.insert(0, '.')
from app.services.vagonweb_client import fetch_vagonweb_composition

async def test():
    for num in ['2412', '2814', '2112']:
        res = await fetch_vagonweb_composition(num)
        print(f"Train {num}: success={res.get('success')} name={res.get('trainName')}")
        comp = res.get('latestActual') or res.get('defaultPlanned')
        if comp:
            print(f"  Comp: {comp.get('displayHeader')} cars={len(comp.get('cars', []))}")
            for c in comp.get('cars', []):
                print(f"    Car: type={c.get('carType')} sub={c.get('carSub')} op={c.get('operator')} isLoco={c.get('isLoco')} img={c.get('imgUrl')}")

if __name__ == '__main__':
    asyncio.run(test())
