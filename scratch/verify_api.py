import urllib.request
import json

def test_api(num):
    url = f"http://127.0.0.1:8000/api/mav/composition/{num}"
    try:
        data = json.loads(urllib.request.urlopen(url).read().decode('utf-8'))
        print(f"Test {num:5}: success={data.get('success')} name={data.get('trainName')} op={data.get('operator')}")
        comp = data.get('latestActual') or data.get('defaultPlanned')
        if comp:
            cars = comp.get('cars', [])
            types = [(c.get('carType'), 'EMU' if c.get('isEmu') else ('LOCO' if c.get('isLoco') else 'CAR')) for c in cars]
            print(f"   Cars ({len(cars)}): {types}")
    except Exception as e:
        print(f"Test {num:5}: Error {e}")

if __name__ == '__main__':
    test_api('2412') # S70 (KISS motorvonat)
    test_api('2814') # Z50
    test_api('2011') # Non-hungarian (should be False)
    test_api('149')  # EC Hortobágy
    test_api('36H5') # HÉV (should be False)
