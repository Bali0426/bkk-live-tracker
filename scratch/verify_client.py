import asyncio
from app.services.vagonweb_client import fetch_vagonweb_composition

async def main():
    for num in ['149', '560', '804', '165']:
        res = await fetch_vagonweb_composition(num)
        print(f"Train {num}: success={res.get('success')} name={res.get('trainName')} hasActual={res.get('hasActual')} hasPlanned={res.get('hasPlanned')}")
        if res.get('latestActual'):
            act = res['latestActual']
            print(f"   Actual: {act.get('displayHeader')} (cars: {len(act.get('cars', []))})")
        if res.get('defaultPlanned'):
            plan = res['defaultPlanned']
            print(f"   Planned: {plan.get('displayHeader')} (cars: {len(plan.get('cars', []))})")

if __name__ == '__main__':
    asyncio.run(main())
