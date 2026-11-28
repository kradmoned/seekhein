
from rag.retriever import retrieve


questions = [
    "What is an array?",
    "How can I access and display array elements?",
    "What is required in Activity 4?",
]


for question in questions:
    print("\n" + "=" * 70)
    print("QUESTION:", question)
    print("=" * 70)

    result = retrieve(
        question=question,
        top_k=3,
        db_path="./test_chroma_lab03",
    )

    for i, (text, source) in enumerate(
        zip(result["context"], result["sources"]),
        start=1,
    ):
        print(f"\nResult {i}")
        print("Source:", source)
        print("Content:", text)
