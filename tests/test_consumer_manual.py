import unittest
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from forge_research.consumer_manual import router
from forge_research.providers.reducto import ReductoError


class ConsumerManualTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def upload(self):
        return self.client.post('/api/consumer-repair/manual', content=b'%PDF-1.4 test', headers={'Content-Type': 'application/pdf'})

    def test_success_is_unreviewed_and_unknowns_remain_null(self):
        with patch('forge_research.consumer_manual.extract', AsyncMock(return_value={'result': {'manufacturer': 'Example'}, 'citations': []})):
            response = self.upload()
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()['facts']['operating_voltage']['value'])
        self.assertFalse(response.json()['catalog_updated'])

    def test_failure_timeout_and_malformed_provider(self):
        for error, status in [(ReductoError('not configured'), 503), (TimeoutError(), 504)]:
            with patch('forge_research.consumer_manual.extract', AsyncMock(side_effect=error)):
                self.assertEqual(self.upload().status_code, status)
        with patch('forge_research.consumer_manual.extract', AsyncMock(return_value={'result': {'model': 123}})):
            self.assertEqual(self.upload().status_code, 502)

    def test_type_signature_and_size(self):
        self.assertEqual(self.client.post('/api/consumer-repair/manual', content=b'x').status_code, 415)
        headers = {'Content-Type': 'application/pdf'}
        self.assertEqual(self.client.post('/api/consumer-repair/manual', content=b'x', headers=headers).status_code, 422)
        self.assertEqual(self.client.post('/api/consumer-repair/manual', content=b'%PDF-' + b'x' * (10 * 1024 * 1024), headers=headers).status_code, 413)
