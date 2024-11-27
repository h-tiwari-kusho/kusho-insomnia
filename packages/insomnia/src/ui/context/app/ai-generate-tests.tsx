import type { FC, PropsWithChildren } from 'react';
import React, { createContext, useCallback, useContext, useState } from 'react';
import { useFetcher } from 'react-router-dom';

import { showModal } from '../../components/modals';
import { AlertModal } from '../../components/modals/alert-modal';

export interface TestCase {
  uuid: string;
  id: string;
  test_suite_id: number;
  description: string;
  categories: string[];
  types: string[];
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    path_params: Record<string, string>;
    json_body: any;
  };
  fields: any[];
  sourceRequestId?: string;
}

interface Request {
  _id: string;
  parentId: string;
  name: string;
  method: string;
  url: string;
  headers?: { name: string; value: string }[];
  pathParameters?: { name: string; value: string }[];
  body?: any;
  description?: string;
}

interface TestGeneratorContextValue {
  isGenerating: boolean;
  error: string | null;
  testCases: TestCase[];
  generateTests: (
    request: Request,
    organizationId: string,
    projectId: string,
    workspaceId: string,
  ) => Promise<void>;
}

interface TestGeneratorProviderProps extends PropsWithChildren {
  machineId: string;
}

const TestGeneratorContext = createContext<TestGeneratorContextValue | null>(null);

export const useTestGenerator = () => {
  const context = useContext(TestGeneratorContext);
  if (!context) {
    throw new Error('useTestGenerator must be used within a TestGeneratorProvider');
  }
  return context;
};

export const TestGeneratorProvider: FC<TestGeneratorProviderProps> = ({
  children,
  machineId,
}) => {
  const folderFetcher = useFetcher();
  const requestFetcher = useFetcher();

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  const createRequest = useCallback(async (
    testCase: TestCase,
    folderId: string,
    organizationId: string,
    projectId: string,
    workspaceId: string
  ) => {
    const req = {
      url: testCase.request.url,
      method: testCase.request.method,
      name: testCase.description,
      description: testCase.description,
      headers: Object.entries(testCase.request.headers).map(([name, value]) => ({ name, value })),
      body: {
        mimeType: 'application/json',
        text: testCase.request.json_body?.text || JSON.stringify(testCase.request.json_body || {}),
      },
      pathParameters: Object.entries(testCase.request.path_params).map(([name, value]) => ({ name, value })),
    };

    await requestFetcher.submit(
      JSON.stringify({ requestType: 'HTTP', parentId: folderId, req }),
      {
        encType: 'application/json',
        action: `/organization/${organizationId}/project/${projectId}/workspace/${workspaceId}/debug/request/new`,
        method: 'post',
      }
    );
  }, [requestFetcher]);

  const generateTests = useCallback(async (
    request: Request,
    organizationId: string,
    projectId: string,
    workspaceId: string,
  ) => {
    if (isGenerating) {
      showModal(AlertModal, {
        title: 'Generation in Progress',
        message: 'Please wait for the current test generation to complete.',
      });
      return;
    }

    setIsGenerating(true);
    setError(null);
    setTestCases([]);

    try {
      // Create folder
      await folderFetcher.submit(
        {
          parentId: request.parentId,
          name: `${request.name} Tests`,
        },
        {
          action: `/organization/${organizationId}/project/${projectId}/workspace/${workspaceId}/debug/request-group/new-response`,
          method: 'post',
        }
      );

      // Wait for folder creation
      await new Promise<string>((resolve, reject) => {
        let checkAttempts = 0;
        const maxAttempts = 100; // 10 seconds

        const checkInterval = setInterval(() => {
          if (folderFetcher.state === 'idle' && folderFetcher.data?.requestGroup?._id) {
            clearInterval(checkInterval);
            resolve(folderFetcher.data.requestGroup._id);
            return;
          }

          checkAttempts++;
          if (checkAttempts >= maxAttempts) {
            clearInterval(checkInterval);
            reject(new Error('Folder creation timed out'));
          }
        }, 100);
      });

      const folderId = folderFetcher.data?.requestGroup?._id;
      if (!folderId) {
        throw new Error('No folder ID available');
      }

      const response = await fetch('https://be.kusho.ai/vscode/generate/streaming', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KUSHO-SOURCE': 'insomnia',
        },
        body: JSON.stringify({
          machine_id: machineId,
          api_info: {
            method: request.method,
            url: request.url,
            headers: request.headers?.reduce((acc, h) => ({ ...acc, [h.name]: h.value }), {}),
            path_params: request.pathParameters?.reduce((acc, p) => ({ ...acc, [p.name]: p.value }), {}),
            json_body: request.body,
            api_desc: request.description,
          },
          test_suite_name: `${request.name} Tests`,
        }),
      });

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const lines = decoder.decode(value).split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const testCase: TestCase = {
                ...JSON.parse(line.substring(5)),
                id: crypto.randomUUID(),
                sourceRequestId: request._id,
              };

              setTestCases(prev => [...prev, testCase]);

              await createRequest(
                testCase,
                folderId,
                organizationId,
                projectId,
                workspaceId
              );
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to generate tests';
      setError(errorMessage);
      showModal(AlertModal, {
        title: 'Error',
        message: errorMessage,
      });
    } finally {
      setIsGenerating(false);
    }
  }, [machineId, isGenerating, createRequest, folderFetcher]);

  const contextValue: TestGeneratorContextValue = {
    isGenerating,
    error,
    testCases,
    generateTests,
  };

  return (
    <TestGeneratorContext.Provider value={contextValue}>
      {children}
    </TestGeneratorContext.Provider>
  );
};

